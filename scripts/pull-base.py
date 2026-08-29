#!/usr/bin/env python3

import json
import os
import subprocess
import sys
import urllib.request


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


def download_blob(url, token, output):
    headers = {}

    if token:
        headers["Authorization"] = "Bearer " + token

    request = urllib.request.Request(
        url,
        headers=headers
    )

    with urllib.request.urlopen(
        request,
        timeout=600
    ) as response:

        with open(output, "wb") as file:

            while True:
                chunk = response.read(1024 * 1024)

                if not chunk:
                    break

                file.write(chunk)


def extract_layer(layer_file, destination):
    result = subprocess.run(
        [
            "tar",
            "-xzf",
            layer_file,
            "-C",
            destination
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE
    )

    if result.returncode != 0:
        print(
            result.stderr.decode(
                "utf-8",
                errors="ignore"
            )
        )

        raise RuntimeError(
            "解压 Docker layer 失败"
        )


def main():

    if len(sys.argv) < 4:
        print(
            "用法："
            "pull-base.py <repo> <tag> <dest>"
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

    print("======================================")
    print("下载 Docker 基础镜像")
    print("======================================")

    print("仓库：", repo)
    print("版本：", tag)
    print("目标：", destination)
    print("Registry：", registry)

    os.makedirs(
        destination,
        exist_ok=True
    )

    token = None

    if "registry-1.docker.io" in registry:

        print("获取 Docker Hub Token...")

        token = get_docker_token(repo)

    manifest_url = (
        "%s/v2/%s/manifests/%s"
        % (
            registry,
            repo,
            tag
        )
    )

    print("获取镜像 Manifest...")

    manifest = fetch_json(
        manifest_url,
        token
    )

    # 多架构镜像
    if "manifests" in manifest:

        selected_digest = None

        for item in manifest["manifests"]:

            platform = item.get(
                "platform",
                {}
            )

            annotations = item.get(
                "annotations",
                {}
            )

            architecture = platform.get(
                "architecture"
            )

            operating_system = platform.get(
                "os"
            )

            reference_type = annotations.get(
                "vnd.docker.reference.type"
            )

            if (
                operating_system == "linux"
                and architecture == "amd64"
                and reference_type != "attestation-manifest"
            ):

                selected_digest = item["digest"]

                break

        if not selected_digest:

            print(
                "错误：没有找到 linux/amd64 镜像"
            )

            sys.exit(1)

        print(
            "选择 linux/amd64：",
            selected_digest
        )

        manifest_url = (
            "%s/v2/%s/manifests/%s"
            % (
                registry,
                repo,
                selected_digest
            )
        )

        manifest = fetch_json(
            manifest_url,
            token
        )

    layers = manifest.get(
        "layers",
        []
    )

    if not layers:

        print(
            "错误：镜像没有 layers"
        )

        sys.exit(1)

    print(
        "Layer 数量：",
        len(layers)
    )

    for index, layer in enumerate(
        layers,
        start=1
    ):

        digest = layer["digest"]

        print("")
        print(
            "下载 Layer %d/%d：%s"
            % (
                index,
                len(layers),
                digest
            )
        )

        blob_url = (
            "%s/v2/%s/blobs/%s"
            % (
                registry,
                repo,
                digest
            )
        )

        temporary_file = (
            "/tmp/unikraft-layer-%d.tar.gz"
            % index
        )

        try:

            download_blob(
                blob_url,
                token,
                temporary_file
            )

            size = os.path.getsize(
                temporary_file
            )

            print(
                "下载完成：%d bytes"
                % size
            )

            extract_layer(
                temporary_file,
                destination
            )

            print(
                "Layer %d/%d 解压完成"
                % (
                    index,
                    len(layers)
                )
            )

        finally:

            if os.path.exists(
                temporary_file
            ):
                os.remove(
                    temporary_file
                )

    print("")
    print("======================================")
    print("rootfs 准备完成")
    print("======================================")
    print(destination)


if __name__ == "__main__":
    main()
