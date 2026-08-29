#!/usr/bin/env bash

set -e

CLI="unikraft"

PHASE="${1:-}"

if [ -z "$PHASE" ]; then
    echo "用法：bash scripts/deploy.sh prepare|build|deploy"
    exit 1
fi

PROJECT_NAME="${PROJECT_NAME:-firefox}"
REGIONS="${REGIONS:-sfo}"
MEMORY_MB="${MEMORY_MB:-1536}"
APP_PORT="${APP_PORT:-3000}"

NAME=$(printf '%s' "$PROJECT_NAME" \
    | tr '[:upper:]' '[:lower:]' \
    | sed 's/[^a-z0-9-]/-/g' \
    | sed 's/^-*//' \
    | sed 's/-*$//')

if [ -z "$NAME" ]; then
    NAME="firefox"
fi

echo ""
echo "======================================"
echo "Firefox + Unikraft Cloud"
echo "======================================"
echo "项目名称：$NAME"
echo "地区：$REGIONS"
echo "内存：${MEMORY_MB}MB"
echo "端口：$APP_PORT"
echo "======================================"


get_org() {

    if [ -n "${UNIKRAFT_ORG:-}" ]; then
        printf '%s' "$UNIKRAFT_ORG"
        return
    fi

    if [ -z "${UNIKRAFT_API_TOKEN:-}" ]; then
        echo "错误：没有 UNIKRAFT_API_TOKEN"
        exit 1
    fi

    TOKEN="$UNIKRAFT_API_TOKEN"

    DECODED=""

    DECODED=$(printf '%s' "$TOKEN" | base64 -d 2>/dev/null || true)

    if [ -n "$DECODED" ]; then

        ORG=$(printf '%s' "$DECODED" \
            | cut -d ':' -f1 \
            | sed 's/^robot\$//' \
            | sed 's/\.users\.kraftcloud$//' \
            | tr -d '\r\n')

    else

        ORG=""

    fi

    if [ -z "$ORG" ]; then
        echo "错误：无法解析组织名称"
        echo "请设置 GitHub Secret：UNIKRAFT_ORG"
        exit 1
    fi

    printf '%s' "$ORG"
}


login() {

    echo ""
    echo "======================================"
    echo "登录 Unikraft"
    echo "======================================"

    if [ -z "${UNIKRAFT_API_TOKEN:-}" ]; then
        echo "错误：没有设置 UNIKRAFT_API_TOKEN"
        exit 1
    fi

    ORG=$(get_org)

    echo "组织：$ORG"

    printf '%s' "$UNIKRAFT_API_TOKEN" \
        | "$CLI" login \
            --token=- \
            --organization "$ORG"

    echo ""
    echo "登录成功"

    export ORG

    IMAGE="unikraft.io/${ORG}/${NAME}:latest"

    export IMAGE

    echo "镜像：$IMAGE"
}


prepare() {

    echo ""
    echo "======================================"
    echo "准备 Firefox"
    echo "======================================"

    if [ ! -f "app/index.js" ]; then
        echo "错误：找不到 app/index.js"
        exit 1
    fi

    if [ ! -f "app/package.json" ]; then
        echo "错误：找不到 app/package.json"
        exit 1
    fi

    if [ ! -f "scripts/pull-base.py" ]; then
        echo "错误：找不到 scripts/pull-base.py"
        exit 1
    fi

    echo "清理旧构建..."

    rm -rf _build

    mkdir -p _build/rootfs

    echo ""
    echo "下载 Node.js 基础 rootfs..."

    python3 scripts/pull-base.py \
        library/node \
        20-alpine \
        _build/rootfs

    echo ""
    echo "安装应用依赖..."

    cd app

    npm install \
        --omit=dev \
        --no-audit \
        --no-fund

    cd ..

    echo ""
    echo "复制 Firefox 应用..."

    mkdir -p _build/rootfs/app

    cp -a app/. \
        _build/rootfs/app/

    echo ""
    echo "创建启动脚本..."

    cat > _build/rootfs/app/start.sh <<'EOF'
#!/bin/sh

echo "======================================"
echo "Firefox + Node.js"
echo "======================================"

cd /app

echo "Node:"
node --version

echo "应用目录:"
ls -la /app

echo "启动 Firefox Node 服务..."

exec node /app/index.js
EOF

    chmod 755 \
        _build/rootfs/app/start.sh

    echo ""
    echo "创建 Kraftfile..."

    cat > _build/Kraftfile <<'EOF'
spec: v0.7

runtime: base-compat:latest

rootfs:
  source: ./rootfs
  format: erofs

cmd:
  - /bin/sh
  - /app/start.sh
EOF

    echo ""
    echo "======================================"
    echo "prepare 完成"
    echo "======================================"
}


build() {

    echo ""
    echo "======================================"
    echo "构建 Firefox Unikraft 镜像"
    echo "======================================"

    login

    if [ ! -d "_build/rootfs" ]; then
        echo "没有 _build/rootfs"
        echo "自动执行 prepare"
        prepare
    fi

    IMAGE="unikraft.io/${ORG}/${NAME}:latest"

    echo ""
    echo "组织：$ORG"
    echo "项目：$NAME"
    echo "镜像：$IMAGE"

    echo ""
    echo "开始构建..."

    "$CLI" build \
        _build \
        --output "$IMAGE"

    echo ""
    echo "======================================"
    echo "镜像构建成功"
    echo "======================================"

    echo "镜像：$IMAGE"
}


deploy() {

    echo ""
    echo "======================================"
    echo "部署 Firefox"
    echo "======================================"

    login

    IMAGE="unikraft.io/${ORG}/${NAME}:latest"

    echo ""
    echo "镜像：$IMAGE"
    echo "地区：$REGIONS"
    echo "内存：${MEMORY_MB}MB"
    echo "端口：$APP_PORT"

    for REGION in $REGIONS; do

        REGION=$(printf '%s' "$REGION" | xargs)

        if [ -z "$REGION" ]; then
            continue
        fi

        echo ""
        echo "======================================"
        echo "地区：$REGION"
        echo "======================================"

        SERVICE_NAME="${NAME}-${REGION}"

        echo ""
        echo "删除旧实例..."

        OLD_IDS=$(
            "$CLI" instances list -o json 2>/dev/null \
            | jq -r \
                --arg NAME "$NAME" \
                --arg REGION "$REGION" \
                '.[] |
                 select(.name == $NAME) |
                 select(.metro == $REGION) |
                 .uuid' \
            || true
        )

        if [ -n "$OLD_IDS" ]; then

            while read -r ID; do

                if [ -n "$ID" ]; then

                    echo "删除：$ID"

                    "$CLI" instances delete \
                        "$ID" \
                        --force \
                        >/dev/null 2>&1 \
                        || true

                fi

            done <<< "$OLD_IDS"

        else

            echo "没有旧实例"

        fi

        sleep 2

        echo ""
        echo "创建服务：$SERVICE_NAME"

        SERVICE_OUTPUT=""

        if SERVICE_OUTPUT=$(
            "$CLI" services create \
                --name "$SERVICE_NAME" \
                --metro "$REGION" \
                --services "443:${APP_PORT}/tls+http" \
                --services "80:443/http+redirect" \
                2>&1
        ); then

            echo "服务创建成功"

        else

            if printf '%s' "$SERVICE_OUTPUT" \
                | grep -qi \
                "already exists\|in use\|conflict"; then

                echo "服务已经存在"

            else

                echo "$SERVICE_OUTPUT"
                exit 1

            fi

        fi

        echo ""
        echo "启动实例..."

        STARTED=0

        for TRY in 1 2 3 4 5 6 7 8; do

            echo ""
            echo "启动尝试：$TRY/8"

            RUN_OUTPUT=""

            if RUN_OUTPUT=$(
                "$CLI" run \
                    --metro "$REGION" \
                    --name "$NAME" \
                    -m "${MEMORY_MB}M" \
                    --service "$SERVICE_NAME" \
                    --scale-to-zero policy=off \
                    -e "PORT=$APP_PORT" \
                    --image "$IMAGE" \
                    2>&1
            ); then

                echo "$RUN_OUTPUT"

                STARTED=1

                break

            else

                echo "$RUN_OUTPUT"

                if printf '%s' "$RUN_OUTPUT" \
                    | grep -qi \
                    "No image\|image.*not found\|not found.*image"; then

                    echo ""
                    echo "镜像正在同步到 $REGION"
                    echo "等待 20 秒..."

                    sleep 20

                else

                    echo ""
                    echo "实例启动失败"

                    break

                fi

            fi

        done

        if [ "$STARTED" != "1" ]; then

            echo ""
            echo "======================================"
            echo "地区 $REGION 部署失败"
            echo "======================================"

            exit 1

        fi

        echo ""
        echo "地区 $REGION 创建成功"

    done

    echo ""
    echo "等待实例状态..."

    sleep 8

    echo ""
    echo "======================================"
    echo "部署结果"
    echo "======================================"

    "$CLI" instances list -o json 2>/dev/null \
        | jq -r \
            --arg NAME "$NAME" \
            '.[] |
             select(.name == $NAME) |
             [
                 .metro,
                 .state,
                 (
                   .services.domains[0].fqdn
                   // .domains[0].fqdn
                   // "?"
                 )
             ] |
             @tsv' \
        | while IFS=$'\t' read -r REGION STATE DOMAIN; do

            echo ""
            echo "地区：$REGION"
            echo "状态：$STATE"

            if [ "$DOMAIN" != "?" ]; then
                echo "地址：https://$DOMAIN"
            else
                echo "地址：暂未分配"
            fi

        done

    echo ""
    echo "======================================"
    echo "Firefox 部署完成"
    echo "======================================"
}


case "$PHASE" in

    prepare)
        prepare
        ;;

    build)
        build
        ;;

    deploy)
        deploy
        ;;

    *)
        echo "未知参数：$PHASE"
        echo ""
        echo "正确用法："
        echo "bash scripts/deploy.sh prepare"
        echo "bash scripts/deploy.sh build"
        echo "bash scripts/deploy.sh deploy"
        exit 1
        ;;

esac
