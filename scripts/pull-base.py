#!/usr/bin/env python3

"""
Docker Hub / GHCR 镜像 rootfs 拉取工具
用于 Unikraft 构建阶段。

用法：

python3 scripts/pull-base.py library/alpine 3.20 _build/rootfs
python3 scripts/pull-base.py library/node 20-alpine _build/rootfs
"""

import json
import os
import subprocess
import sys
import urllib.request
import urllib.error


ACCEPT = ",".join([
    "application/vnd.oci.image.index.v1+json",
    "application/vnd.docker.distribution.manifest.list.v2+json",
    "application/vnd.oci.image.manifest.v1+json",
    "application/vnd.docker.distribution.manifest.v2+json",
])


def http_json(url, token=None):

    headers = {
        "User-Agent": "Unikraft-Firefox-Builder/1.0",
        "Accept": ACCEPT,
    }

    if token:
        headers["Authorization"] = "Bearer " + token

    req = urllib.request.Request(
        url,
        headers=headers
    )

    with urllib.request.urlopen(req, timeout=120) as response:
        return json.loads(response.read())


def get_docker_token(repo):

    url = (
        "https://auth.docker.io/token"
        "?service=registry.docker.io"
        "&scope=repository:%s:pull"
        % repo
    )

    data = http_json(url)

    token = data.get("token")

    if not token:
        raise RuntimeError(
            "无法获取 Docker Hub token"
        )

    return token


def get_ghcr_token(repo):

    url = (
        "https://ghcr.io/token"
        "?scope=repository:%s:pull"
        % repo
    )

    data = http_json(url)

    token = data.get("token")

    if not token:
        raise RuntimeError(
            "无法获取 GHCR token"
        )

    return token


def select_amd64(manifest):

    manifests = manifest.get("manifests", [])

    for item in manifests:

        platform = item.get("platform") or {}

        architecture = platform.get(
            "architecture"
        )

        operating_system = platform.get(
            "os"
        )

        annotations = item.get(
            "annotations"
        ) or {}

        if (
            operating_system == "linux"
            and architecture == "amd64"
            and annotations.get(
                "vnd.docker.reference.type"
            ) != "attestation-manifest"
        ):
            return item["digest"]

    raise RuntimeError(
        "镜像没有 linux/amd64 版本"
    )


def download_blob(
    registry,
    repo,
    digest,
    token,
    filename
):

    url = (
        "%s/v2/%s/blobs/%s"
        % (
            registry,
            repo,
            digest
        )
    )

    headers = {
        "User-Agent": "Unikraft-Firefox-Builder/1.0"
    }

    if token:
        headers["Authorization"] = (
            "Bearer " + token
        )

    request = urllib.request.Request(
        url,
        headers=headers
    )

    print(
        "下载 layer：%s"
        % digest
    )

    with urllib.request.urlopen(
        request,
        timeout=900
    ) as response:

        with open(
            filename,
            "wb"
        ) as output:

            while True:

                chunk = response.read(
                    1024 * 1024
                )

                if not chunk:
                    break

                output.write(chunk)


def extract_layer(
    archive,
    destination
):

    os.makedirs(
        destination,
        exist_ok=True
    )

    result = subprocess.run(
        [
            "tar",
            "-xzf",
            archive,
            "-C",
            destination
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE
    )

    if result.returncode != 0:

        error = result.stderr.decode(
            "utf-8",
            errors="replace"
        )

        raise RuntimeError(
            "解压 layer 失败：\n"
            + error
        )


def main():

    if len(sys.argv) < 4:

        print(
            "用法："
        )

        print(
            "python3 scripts/pull-base.py "
            "<repo> <tag> <dest> "
            "[registry]"
        )

        sys.exit(1)

    repo = sys.argv[1]
    tag = sys.argv[2]
    destination = sys.argv[3]

    registry = (
        sys.argv[4]
        if len(sys.argv) >= 5
        else "https://registry-1.docker.io"
    )

    print(
        "======================================"
    )

    print(
        "拉取基础镜像"
    )

    print(
        "======================================"
    )

    print(
        "Registry : %s"
        % registry
    )

    print(
        "Repository: %s"
        % repo
    )

    print(
        "Tag      : %s"
        % tag
    )

    print(
        "Target   : %s"
        % destination
    )

    # --------------------------------
    # 获取认证 token
    # --------------------------------

    token = None

    if "ghcr.io" in registry:

        print(
            "获取 GHCR token..."
        )

        token = get_ghcr_token(
            repo
        )

    elif "registry-1.docker.io" in registry:

        print(
            "获取 Docker Hub token..."
        )

        token = get_docker_token(
            repo
        )

    else:

        print(
            "使用匿名 Registry..."
        )

    # --------------------------------
    # 获取 manifest
    # --------------------------------

    manifest_url = (
        "%s/v2/%s/manifests/%s"
        % (
            registry,
            repo,
            tag
        )
    )

    print(
        "获取镜像 manifest..."
    )

    manifest = http_json(
        manifest_url,
        token
    )

    # --------------------------------
    # 多架构镜像
    # --------------------------------

    if "manifests" in manifest:

        print(
            "检测到多架构镜像"
        )

        digest = select_amd64(
            manifest
        )

        print(
            "选择 linux/amd64：%s"
            % digest
        )

        manifest_url = (
            "%s/v2/%s/manifests/%s"
            % (
                registry,
                repo,
                digest
            )
        )

        manifest = http_json(
            manifest_url,
            token
        )

    # --------------------------------
    # 获取 layers
    # --------------------------------

    layers = manifest.get(
        "layers",
        []
    )

    if not layers:

        raise RuntimeError(
            "镜像没有 layers"
        )

    print(
        "Layers：%d"
        % len(layers)
    )

    os.makedirs(
        destination,
        exist_ok=True
    )

    # --------------------------------
    # 下载并解压
    # --------------------------------

    for index, layer in enumerate(
        layers,
        start=1
    ):

        digest = layer["digest"]

        size = layer.get(
            "size",
            0
        )

        temporary = (
            "/tmp/"
            "unikraft-layer-%d.tar.gz"
            % index
        )

        print(
            ""
        )

        print(
            "[%d/%d] 下载 %.2f MB"
            % (
                index,
                len(layers),
                size / 1024 / 1024
            )
        )

        try:

            download_blob(
                registry,
                repo,
                digest,
                token,
                temporary
            )

            extract_layer(
                temporary,
                destination
            )

        finally:

            if os.path.exists(
                temporary
            ):

                os.remove(
                    temporary
                )

        print(
            "[%d/%d] 完成"
            % (
                index,
                len(layers)
            )
        )

    # --------------------------------
    # 获取镜像 Config
    # --------------------------------

    config = manifest.get(
        "config"
    )

    if config:

        digest = config.get(
            "digest"
        )

        if digest:

            print(
                "读取镜像启动配置..."
            )

            url = (
                "%s/v2/%s/blobs/%s"
                % (
                    registry,
                    repo,
                    digest
                )
            )

            headers = {
                "User-Agent":
                    "Unikraft-Firefox-Builder/1.0",
                "Authorization":
                    "Bearer " + token
                    if token
                    else ""
            }

            request = urllib.request.Request(
                url,
                headers=headers
            )

            try:

                with urllib.request.urlopen(
                    request,
                    timeout=120
                ) as response:

                    image_config = json.loads(
                        response.read()
                    )

                runtime = (
                    image_config.get(
                        "config"
                    ) or {}
                )

                result = {
                    "entrypoint":
                        runtime.get(
                            "Entrypoint"
                        ) or [],

                    "cmd":
                        runtime.get(
                            "Cmd"
                        ) or [],

                    "working_dir":
                        runtime.get(
                            "WorkingDir"
                        ) or "/",

                    "env":
                        runtime.get(
                            "Env"
                        ) or [],
                }

                with open(
                    os.path.join(
                        destination,
                        ".image-config.json"
                    ),
                    "w",
                    encoding="utf-8"
                ) as f:

                    json.dump(
                        result,
                        f,
                        ensure_ascii=False,
                        indent=2
                    )

                print(
                    "镜像启动配置已保存"
                )

            except Exception as error:

                print(
                    "警告：读取镜像启动配置失败：%s"
                    % error
                )

    # --------------------------------
    # 检查 rootfs
    # --------------------------------

    important = [
        "bin",
        "usr",
        "etc"
    ]

    found = []

    for item in important:

        if os.path.exists(
            os.path.join(
                destination,
                item
            )
        ):

            found.append(item)

    if not found:

        raise RuntimeError(
            "rootfs 解包异常，"
            "没有找到 bin/usr/etc"
        )

    print(
        ""
    )

    print(
        "======================================"
    )

    print
