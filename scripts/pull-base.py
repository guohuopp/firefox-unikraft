#!/usr/bin/env python3

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


def fetch_json(url, token=None):
    req = urllib.request.Request(url)

    req.add_header("Accept", ACCEPT)

    if token:
        req.add_header(
            "Authorization",
            "Bearer " + token
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

    data = fetch_json(url)

    return data["token"]


def download_blob(
    registry,
    repo,
    digest,
    token,
    output
):
    url = "%s/v2/%s/blobs/%s" % (
        registry,
        repo,
        digest
    )

    print("")
    print("下载 layer：")
    print(digest)

    headers = {}

    if token:
        headers["Authorization"] = "Bearer " + token

    request = urllib.request.Request(
        url,
        headers=headers
    )

    with urllib.request.urlopen(
        request,
        timeout=900
    ) as response:

        total = 0

        with open(output, "wb") as f:

            while True:

                chunk = response.read(
                    1024 * 1024
                )

                if not chunk:
                    break

                f.write(chunk)

                total += len(chunk)

    print(
        "下载完成：%d bytes"
        % total
    )


def extract_layer(
    archive,
    destination
):
    print(
        "解压：%s"
        % archive
    )

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
            destination,
        ],
        text=True
    )

    if result.returncode != 0:

        print(
            "gzip layer 解压失败，尝试普通 tar..."
        )

        result = subprocess.run(
            [
                "tar",
                "-xf",
                archive,
                "-C",
                destination,
            ],
            text=True
        )

        if result.returncode != 0:
            raise RuntimeError(
                "无法解压镜像 layer"
            )


def select_amd64_manifest(index):
    manifests = index.get(
        "manifests",
        []
    )

    for manifest in manifests:

        platform = manifest.get(
            "platform"
        ) or {}

        annotations = manifest.get(
            "annotations"
        ) or {}

        if (
            platform.get("os") == "linux"
            and
            platform.get("architecture") == "amd64"
            and
            annotations.get(
                "vnd.docker.reference.type"
            ) != "attestation-manifest"
        ):

            return manifest["digest"]

    raise RuntimeError(
        "镜像没有 linux/amd64 版本"
    )


def get_manifest(
    registry,
    repo,
    reference,
    token
):
    url = (
        "%s/v2/%s/manifests/%s"
        % (
            registry,
            repo,
            reference
        )
    )

    return fetch_json(
        url,
        token
    )


def main():

    if len(sys.argv) < 4:

        print(
            "用法："
        )

        print(
            "pull-base.py <repo> <tag> <dest>"
        )

        sys.exit(1)

    repo = sys.argv[1]
    tag = sys.argv[2]
    destination = sys.argv[3]

    registry = (
        "https://registry-1.docker.io"
    )

    print("")
    print(
        "======================================"
    )

    print(
        "拉取 Docker Hub 基础镜像"
    )

    print(
        "======================================"
    )

    print(
        "仓库：%s"
        % repo
    )

    print(
        "版本：%s"
        % tag
    )

    print(
        "架构：linux/amd64"
    )

    print(
        "目标：%s"
        % destination
    )

    print("")

    # ------------------------------------------------------
    # Docker Hub token
    # ------------------------------------------------------

    token = get_docker_token(
        repo
    )

    # ------------------------------------------------------
    # 获取 manifest
    # ------------------------------------------------------

    index = get_manifest(
        registry,
        repo,
        tag,
        token
    )

    # ------------------------------------------------------
    # 多架构镜像
    # ------------------------------------------------------

    if "manifests" in index:

        print(
            "检测到多架构镜像"
        )

        digest = select_amd64_manifest(
            index
        )

        print(
            "选择 amd64：%s"
            % digest
        )

        manifest = get_manifest(
            registry,
            repo,
            digest,
            token
        )

    else:

        manifest = index

    # ------------------------------------------------------
    # 检查 architecture
    # ------------------------------------------------------

    print("")

    print(
        "镜像配置："
    )

    print(
        "architecture = %s"
        % manifest.get(
            "architecture",
            "unknown"
        )
    )

    print(
        "os = %s"
        % manifest.get(
            "os",
            "unknown"
        )
    )

    layers = manifest.get(
        "layers",
        []
    )

    if not layers:

        raise RuntimeError(
            "镜像没有 layers"
        )

    # ------------------------------------------------------
    # 清理并创建 rootfs
    # ------------------------------------------------------

    os.makedirs(
        destination,
        exist_ok=True
    )

    # ------------------------------------------------------
    # 下载并解压每一层
    # ------------------------------------------------------

    for index_no, layer in enumerate(
        layers,
        start=1
    ):

        digest = layer["digest"]

        safe_digest = (
            digest
            .replace(":", "_")
        )

        temporary = (
            "/tmp/unikraft-layer-%s.tar"
            % safe_digest
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

            print(
                "layer %d/%d OK"
                % (
                    index_no,
                    len(layers)
                )
            )

        finally:

            if os.path.exists(
                temporary
            ):
                os.remove(
                    temporary
                )

    # ------------------------------------------------------
    # 输出镜像配置
    # ------------------------------------------------------

    config_descriptor = (
        manifest.get(
            "config"
        ) or {}
    )

    config_digest = (
        config_descriptor.get(
            "digest"
        )
    )

    if config_digest:

        print("")
        print(
            "读取 Node.js 基础镜像配置..."
        )

        config_url = (
            "%s/v2/%s/blobs/%s"
            % (
                registry,
                repo,
                config_digest
            )
        )

        headers = {
            "Authorization":
                "Bearer " + token
        }

        request = urllib.request.Request(
            config_url,
            headers=headers
        )

        with urllib.request.urlopen(
            request,
            timeout=120
        ) as response:

            config = json.loads(
                response.read()
            )

        container_config = (
            config.get("config")
            or {}
        )

        print("")
        print(
            "基础镜像启动信息："
        )

        print(
            json.dumps(
                {
                    "entrypoint":
                        container_config.get(
                            "Entrypoint"
                        ),
                    "cmd":
                        container_config.get(
                            "Cmd"
                        ),
                    "working_dir":
                        container_config.get(
                            "WorkingDir"
                        ),
                    "env":
                        container_config.get(
                            "Env"
                        ),
                },
                indent=2,
                ensure_ascii=False
            )
        )

    # ------------------------------------------------------
    # 检查 Debian glibc
    # ------------------------------------------------------

    print("")
    print(
        "======================================"
    )

    print(
        "检查 glibc 环境"
    )

    print(
        "======================================"
    )

    possible_loaders = [
        os.path.join(
            destination,
            "lib64",
            "ld-linux-x86-64.so.2"
        ),
        os.path.join(
            destination,
            "lib",
            "x86_64-linux-gnu",
            "ld-linux-x86-64.so.2"
        ),
    ]

    loader_found = False

    for loader in possible_loaders:

        if os.path.exists(loader):

            print(
                "动态加载器：%s"
                % loader
            )

            loader_found = True

    if not loader_found:

        print(
            "警告：没有找到 "
            "ld-linux-x86-64.so.2"
        )

    # ------------------------------------------------------
    # 检查 Node
    # ------------------------------------------------------

    node_binary = os.path.join(
        destination,
        "usr",
        "local",
        "bin",
        "node"
    )

    if os.path.exists(
        node_binary
    ):

        print(
            "Node.js：OK"
        )

    else:

        print(
            "警告：没有找到 Node.js"
        )

    # ------------------------------------------------------
    # 完成
    # ------------------------------------------------------

    print("")
    print(
        "======================================"
    )

    print(
        "rootfs 就绪"
    )

    print(
        "======================================"
    )

    print(
        destination
    )


if __name__ == "__main__":
    main()
