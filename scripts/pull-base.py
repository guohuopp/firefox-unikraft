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


def request_json(url, token=None):
    request = urllib.request.Request(url)

    request.add_header("Accept", ACCEPT)

    if token:
        request.add_header(
            "Authorization",
            "Bearer " + token
        )

    with urllib.request.urlopen(
        request,
        timeout=120
    ) as response:

        return json.loads(
            response.read()
        )


def get_docker_token(repo):
    url = (
        "https://auth.docker.io/token"
        "?service=registry.docker.io"
        "&scope=repository:%s:pull"
        % repo
    )

    print("获取 Docker Hub Token...")

    data = request_json(url)

    token = data.get("token")

    if not token:
        raise RuntimeError(
            "无法获取 Docker Hub Token"
        )

    return token


def download_blob(
    registry,
    repo,
    digest,
    token,
    output
):

    url = (
        "%s/v2/%s/blobs/%s"
        % (
            registry,
            repo,
            digest
        )
    )

    request = urllib.request.Request(url)

    if token:
        request.add_header(
            "Authorization",
            "Bearer " + token
        )

    print("")
    print("下载：%s" % digest)

    with urllib.request.urlopen(
        request,
        timeout=900
    ) as response:

        total = 0

        with open(
            output,
            "wb"
        ) as file:

            while True:

                chunk = response.read(
                    1024 * 1024
                )

                if not chunk:
                    break

                file.write(chunk)

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
        "解包：%s"
        % os.path.basename(archive)
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
        stderr=subprocess.PIPE,
        text=True
    )

    if result.returncode != 0:

        print(
            "tar 解包失败："
        )

        print(
            result.stderr
        )

        raise RuntimeError(
            "Docker layer 解包失败"
        )


def select_amd64(manifest):

    manifests = manifest.get(
        "manifests",
        []
    )

    for item in manifests:

        platform = item.get(
            "platform",
            {}
        )

        architecture = platform.get(
            "architecture"
        )

        operating_system = platform.get(
            "os"
        )

        annotations = item.get(
            "annotations",
            {}
        )

        reference_type = annotations.get(
            "vnd.docker.reference.type"
        )

        if (
            operating_system == "linux"
            and
            architecture == "amd64"
            and
            reference_type != "attestation-manifest"
        ):

            return item.get(
                "digest"
            )

    return None


def main():

    if len(sys.argv) < 4:

        print(
            "用法："
        )

        print(
            "python3 scripts/pull-base.py "
            "<repo> <tag> <dest>"
        )

        print("")
        print(
            "例如："
        )

        print(
            "python3 scripts/pull-base.py "
            "library/node 20-alpine _build/rootfs"
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
        "Docker 基础镜像下载器"
    )

    print(
        "======================================"
    )

    print(
        "镜像：%s:%s"
        % (
            repo,
            tag
        )
    )

    print(
        "平台：linux/amd64"
    )

    print(
        "目标：%s"
        % destination
    )

    print(
        "======================================"
    )

    os.makedirs(
        destination,
        exist_ok=True
    )

    # --------------------------------------
    # 获取 Docker Hub Token
    # --------------------------------------

    try:

        token = get_docker_token(
            repo
        )

    except Exception as error:

        print("")
        print(
            "获取 Docker Hub Token 失败："
        )

        print(
            str(error)
        )

        sys.exit(1)

    # --------------------------------------
    # 获取镜像 Manifest
    # --------------------------------------

    manifest_url = (
        "%s/v2/%s/manifests/%s"
        % (
            registry,
            repo,
            tag
        )
    )

    print("")
    print(
        "获取镜像 Manifest..."
    )

    try:

        manifest = request_json(
            manifest_url,
            token
        )

    except Exception as error:

        print("")
        print(
            "获取 Manifest 失败："
        )

        print(
            str(error)
        )

        sys.exit(1)

    # --------------------------------------
    # 多架构镜像
    # --------------------------------------

    if "manifests" in manifest:

        print(
            "检测到多架构镜像"
        )

        digest = select_amd64(
            manifest
        )

        if not digest:

            print(
                "错误：没有找到 linux/amd64 镜像"
            )

            sys.exit(1)

        print(
            "选择 amd64：%s"
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

        try:

            manifest = request_json(
                manifest_url,
                token
            )

        except Exception as error:

            print(
                "获取 amd64 Manifest 失败："
            )

            print(
                str(error)
            )

            sys.exit(1)

    # --------------------------------------
    # 获取 layers
    # --------------------------------------

    layers = manifest.get(
        "layers",
        []
    )

    if not layers:

        print(
            "错误：Manifest 中没有 layers"
        )

        sys.exit(1)

    print("")
    print(
        "Layer 数量：%d"
        % len(layers)
    )

    # --------------------------------------
    # 下载并解包 layers
    # --------------------------------------

    for index, layer in enumerate(
        layers,
        start=1
    ):

        digest = layer.get(
            "digest"
        )

        if not digest:

            print(
                "错误：Layer 没有 digest"
            )

            sys.exit(1)

        safe_digest = digest.replace(
            ":",
            "_"
        )

        temporary_file = (
            "/tmp/"
            "unikraft-layer-%d-%s.tar.gz"
            % (
                index,
                safe_digest
            )
        )

        print("")
        print(
            "======================================"
        )

        print(
            "Layer %d/%d"
            % (
                index,
                len(layers)
            )
        )

        print(
            "大小：%d bytes"
            % layer.get(
                "size",
                0
            )
        )

        try:

            download_blob(
                registry,
                repo,
                digest,
                token,
                temporary_file
            )

            extract_layer(
                temporary_file,
                destination
            )

        finally:

            if os.path.exists(
                temporary_file
            ):

                os.remove(
                    temporary_file
                )

        print(
            "Layer %d/%d 完成"
            % (
                index,
                len(layers)
            )
        )

    # --------------------------------------
    # 完成
    # --------------------------------------

    print("")
    print(
        "======================================"
    )

    print(
        "rootfs 准备完成"
    )

    print(
        "======================================"
    )

    print(
        "位置：%s"
        % destination
    )

    # --------------------------------------
    # 检查 Node
    # --------------------------------------

    node_path = os.path.join(
        destination,
        "usr",
        "local",
        "bin",
        "node"
    )

    if os.path.exists(
        node_path
    ):

        print(
            "Node.js：已找到"
        )

    else:

        print(
            "警告：没有检测到 /usr/local/bin/node"
        )

    print("")
    print(
        "基础镜像下载完成"
    )


if __name__ == "__main__":

    main()
