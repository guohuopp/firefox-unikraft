const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");
const { execFileSync } = require("child_process");

const PORT = Number(process.env.PORT || 3000);

const APP_DIR = "/app";
const FIREFOX_DIR = path.join(APP_DIR, "firefox");
const PROFILE_DIR = path.join(APP_DIR, "firefox-profile");

let FIREFOX_BIN = path.join(
    FIREFOX_DIR,
    "firefox",
    "firefox"
);

const VERSION_FILE = path.join(
    FIREFOX_DIR,
    ".version"
);

const VERSION_API =
    "https://product-details.mozilla.org/1.0/firefox_versions.json";

let firefoxProcess = null;
let browserRunning = false;
let currentVersion = "unknown";

function log(message) {
    console.log(`[Firefox] ${message}`);
}

function request(url, redirects = 0) {
    return new Promise((resolve, reject) => {

        if (redirects > 10) {
            return reject(
                new Error("Too many redirects")
            );
        }

        const client =
            url.startsWith("https://")
                ? https
                : http;

        const req = client.get(
            url,
            {
                headers: {
                    "User-Agent":
                        "Firefox-Unikraft/1.0"
                }
            },
            res => {

                if (
                    res.statusCode >= 300 &&
                    res.statusCode < 400 &&
                    res.headers.location
                ) {

                    res.resume();

                    let location =
                        res.headers.location;

                    if (
                        location.startsWith("/")
                    ) {
                        const base =
                            new URL(url);

                        location =
                            `${base.protocol}//${base.host}${location}`;
                    }

                    return request(
                        location,
                        redirects + 1
                    )
                        .then(resolve)
                        .catch(reject);
                }

                const chunks = [];

                res.on(
                    "data",
                    chunk => chunks.push(chunk)
                );

                res.on(
                    "end",
                    () => {

                        const body =
                            Buffer.concat(chunks);

                        if (
                            res.statusCode >= 200 &&
                            res.statusCode < 300
                        ) {

                            resolve(body);

                        } else {

                            reject(
                                new Error(
                                    `HTTP ${res.statusCode}: ${body
                                        .toString()
                                        .slice(0, 300)}`
                                )
                            );
                        }
                    }
                );
            }
        );

        req.setTimeout(
            120000,
            () => {
                req.destroy(
                    new Error("Request timeout")
                );
            }
        );

        req.on(
            "error",
            reject
        );
    });
}

function getArchitecture() {

    const arch = os.arch();

    log(`系统架构：${arch}`);

    if (arch === "x64") {
        return "linux-x86_64";
    }

    if (arch === "arm64") {
        return "linux-aarch64";
    }

    throw new Error(
        `不支持架构：${arch}`
    );
}

async function getLatestVersion() {

    log(
        "正在获取 Firefox 最新版本..."
    );

    const data =
        await request(VERSION_API);

    const json =
        JSON.parse(
            data.toString()
        );

    const version =
        json.LATEST_FIREFOX_VERSION;

    if (!version) {
        throw new Error(
            "无法获取 Firefox 最新版本"
        );
    }

    log(
        `Mozilla 最新 Firefox：${version}`
    );

    return version;
}

function getInstalledVersion() {

    if (
        !fs.existsSync(VERSION_FILE)
    ) {
        return null;
    }

    try {

        return fs
            .readFileSync(
                VERSION_FILE,
                "utf8"
            )
            .trim();

    } catch {

        return null;
    }
}

async function downloadFirefox(version) {

    const architecture =
        getArchitecture();

    const url =
        `https://ftp.mozilla.org/pub/firefox/releases/${version}/${architecture}/en-US/firefox-${version}.tar.xz`;

    const archive =
        path.join(
            APP_DIR,
            `firefox-${version}.tar.xz`
        );

    log(
        `正在下载 Firefox ${version}...`
    );

    log(url);

    const data =
        await request(url);

    fs.writeFileSync(
        archive,
        data
    );

    log(
        `下载完成：${(
            data.length /
            1024 /
            1024
        ).toFixed(2)} MB`
    );

    return archive;
}

function installFirefox(version, archive) {

    log("正在解压 Firefox...");

    if (
        fs.existsSync(FIREFOX_DIR)
    ) {

        fs.rmSync(
            FIREFOX_DIR,
            {
                recursive: true,
                force: true
            }
        );
    }

    fs.mkdirSync(
        FIREFOX_DIR,
        {
            recursive: true
        }
    );

    execFileSync(
        "tar",
        [
            "-xJf",
            archive,
            "-C",
            FIREFOX_DIR
        ],
        {
            stdio: "inherit"
        }
    );

    const expected =
        path.join(
            FIREFOX_DIR,
            "firefox",
            "firefox"
        );

    if (
        !fs.existsSync(expected)
    ) {

        throw new Error(
            `Firefox 解压失败：${expected}`
        );
    }

    fs.chmodSync(
        expected,
        0o755
    );

    FIREFOX_BIN = expected;

    fs.writeFileSync(
        VERSION_FILE,
        version
    );

    log(
        `Firefox ${version} 安装完成`
    );

    if (
        fs.existsSync(archive)
    ) {

        fs.rmSync(
            archive,
            {
                force: true
            }
        );
    }
}

function findFirefox() {

    const candidates = [

        path.join(
            APP_DIR,
            "firefox",
            "firefox",
            "firefox"
        ),

        "/app/firefox/firefox/firefox",

        "/opt/firefox/firefox/firefox",

        "/usr/local/bin/firefox",

        "/usr/bin/firefox"
    ];

    for (const file of candidates) {

        if (
            fs.existsSync(file)
        ) {

            try {

                fs.accessSync(
                    file,
                    fs.constants.X_OK
                );

            } catch {

                try {
                    fs.chmodSync(
                        file,
                        0o755
                    );
                } catch {}
            }

            return file;
        }
    }

    return null;
}

function startFirefox() {

    if (firefoxProcess) {
        return;
    }

    FIREFOX_BIN =
        findFirefox();

    if (!FIREFOX_BIN) {

        throw new Error(
            "找不到 Firefox 可执行文件"
        );
    }

    fs.mkdirSync(
        PROFILE_DIR,
        {
            recursive: true
        }
    );

    log(
        `Firefox 文件路径：${FIREFOX_BIN}`
    );

    log(
        "正在启动 Firefox Headless..."
    );

    const args = [
        "--headless",
        "--no-remote",
        "--profile",
        PROFILE_DIR,
        "--width",
        "1280",
        "--height",
        "720",
        "about:blank"
    ];

    log(
        `启动参数：${JSON.stringify(args)}`
    );

    firefoxProcess =
        spawn(
            FIREFOX_BIN,
            args,
            {
                cwd: APP_DIR,
                env: {
                    ...process.env,
                    HOME: APP_DIR,
                    MOZ_HEADLESS: "1"
                },
                stdio: [
                    "ignore",
                    "pipe",
                    "pipe"
                ]
            }
        );

    firefoxProcess.stdout.on(
        "data",
        data => {
            console.log(
                `[Firefox stdout] ${data.toString().trim()}`
            );
        }
    );

    firefoxProcess.stderr.on(
        "data",
        data => {
            console.log(
                `[Firefox stderr] ${data.toString().trim()}`
            );
        }
    );

    firefoxProcess.on(
        "spawn",
        () => {

            browserRunning = true;

            log(
                "Firefox Headless 已启动"
            );
        }
    );

    firefoxProcess.on(
        "error",
        error => {

            browserRunning = false;

            console.error(
                "[Firefox] 启动失败：",
                error
            );
        }
    );

    firefoxProcess.on(
        "exit",
        (code, signal) => {

            browserRunning = false;

            log(
                `Firefox 已退出 code=${code} signal=${signal}`
            );

            firefoxProcess = null;
        }
    );
}

function startServer() {

    const server =
        http.createServer(
            (req, res) => {

                res.setHeader(
                    "Content-Type",
                    "application/json; charset=utf-8"
                );

                if (
                    req.url === "/" ||
                    req.url === "/status"
                ) {

                    res.writeHead(200);

                    res.end(
                        JSON.stringify(
                            {
                                status: "ok",
                                browser: "Firefox",
                                version:
                                    currentVersion,
                                running:
                                    browserRunning,
                                port: PORT,
                                executable:
                                    FIREFOX_BIN
                            },
                            null,
                            2
                        )
                    );

                    return;
                }

                if (
                    req.url === "/health"
                ) {

                    const status =
                        browserRunning
                            ? 200
                            : 503;

                    res.writeHead(status);

                    res.end(
                        JSON.stringify(
                            {
                                status:
                                    browserRunning
                                        ? "ok"
                                        : "starting",
                                browser:
                                    "Firefox",
                                version:
                                    currentVersion,
                                running:
                                    browserRunning
                            }
                        )
                    );

                    return;
                }

                if (
                    req.url === "/version"
                ) {

                    res.writeHead(200);

                    res.end(
                        JSON.stringify(
                            {
                                browser:
                                    "Firefox",
                                version:
                                    currentVersion
                            },
                            null,
                            2
                        )
                    );

                    return;
                }

                res.writeHead(404);

                res.end(
                    JSON.stringify({
                        error: "Not Found"
                    })
                );
            }
        );

    server.listen(
        PORT,
        "0.0.0.0",
        () => {

            log(
                `HTTP 服务监听：0.0.0.0:${PORT}`
            );
        }
    );
}

async function main() {

    console.log("");
    console.log(
        "======================================"
    );
    console.log(
        "       Firefox + Unikraft Cloud"
    );
    console.log(
        "======================================"
    );

    log(
        `Node.js：${process.version}`
    );

    log(
        `架构：${os.arch()}`
    );

    log(
        `PORT：${PORT}`
    );

    startServer();

    try {

        const installed =
            getInstalledVersion();

        const existing =
            findFirefox();

        if (
            installed &&
            existing
        ) {

            currentVersion =
                installed;

            FIREFOX_BIN =
                existing;

            log(
                `已有 Firefox：${installed}`
            );

        } else {

            const latest =
                await getLatestVersion();

            const archive =
                await downloadFirefox(
                    latest
                );

            installFirefox(
                latest,
                archive
            );

            currentVersion =
                latest;
        }

        startFirefox();

    } catch (error) {

        browserRunning = false;

        console.error(
            "[Firefox] 启动失败："
        );

        console.error(
            error.stack || error
        );
    }
}

function shutdown() {

    log(
        "正在关闭 Firefox..."
    );

    if (
        firefoxProcess &&
        !firefoxProcess.killed
    ) {

        firefoxProcess.kill(
            "SIGTERM"
        );
    }

    setTimeout(
        () => process.exit(0),
        1000
    );
}

process.on(
    "SIGTERM",
    shutdown
);

process.on(
    "SIGINT",
    shutdown
);

main();
