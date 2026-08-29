"use strict";

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { execFileSync } = require("child_process");
const { pipeline } = require("stream");
const { promisify } = require("util");

const pipelineAsync = promisify(pipeline);

const PORT = Number(process.env.PORT || 3000);

const FIREFOX_VERSION =
    process.env.FIREFOX_VERSION || "154.0.1";

const FIREFOX_DIR =
    "/app/firefox";

const FIREFOX_EXTRACT_DIR =
    path.join(FIREFOX_DIR, "firefox");

const FIREFOX_EXECUTABLE =
    path.join(
        FIREFOX_EXTRACT_DIR,
        "firefox"
    );

const PROFILE_DIR =
    process.env.FIREFOX_PROFILE ||
    "/app/firefox-profile";

const DOWNLOAD_URL =
    "https://ftp.mozilla.org/pub/firefox/releases/" +
    FIREFOX_VERSION +
    "/linux-x86_64/en-US/firefox-" +
    FIREFOX_VERSION +
    ".tar.xz";

let firefoxProcess = null;

let firefoxState = {
    running: false,
    error: null,
    pid: null,
    startedAt: null
};


// ============================================================
// 日志
// ============================================================

function log(...args) {
    console.log(
        "[Firefox]",
        ...args
    );
}


// ============================================================
// HTTP 下载
// ============================================================

function downloadFile(
    url,
    destination
) {
    return new Promise(
        (resolve, reject) => {

            const file =
                fs.createWriteStream(
                    destination
                );

            const request =
                https.get(
                    url,
                    {
                        headers: {
                            "User-Agent":
                                "Mozilla/5.0 Firefox-Unikraft"
                        }
                    },
                    response => {

                        // Mozilla CDN 可能重定向
                        if (
                            response.statusCode >= 300 &&
                            response.statusCode < 400 &&
                            response.headers.location
                        ) {

                            file.close();

                            try {
                                fs.unlinkSync(
                                    destination
                                );
                            } catch (_) {}

                            downloadFile(
                                response.headers.location,
                                destination
                            )
                            .then(resolve)
                            .catch(reject);

                            return;
                        }

                        if (
                            response.statusCode !== 200
                        ) {

                            file.close();

                            try {
                                fs.unlinkSync(
                                    destination
                                );
                            } catch (_) {}

                            reject(
                                new Error(
                                    "HTTP " +
                                    response.statusCode
                                )
                            );

                            return;
                        }

                        response.pipe(file);

                        file.on(
                            "finish",
                            () => {

                                file.close(
                                    () => resolve()
                                );

                            }
                        );

                    }
                );

            request.on(
                "error",
                error => {

                    file.close();

                    try {
                        fs.unlinkSync(
                            destination
                        );
                    } catch (_) {}

                    reject(error);
                }
            );

        }
    );
}


// ============================================================
// 执行命令
// ============================================================

function commandExists(
    command
) {
    try {

        execFileSync(
            "sh",
            [
                "-c",
                "command -v " +
                command
            ],
            {
                stdio: "ignore"
            }
        );

        return true;

    } catch (_) {

        return false;
    }
}


// ============================================================
// Firefox 文件检查
// ============================================================

function inspectFirefox() {

    log(
        "检查 Firefox：",
        FIREFOX_EXECUTABLE
    );

    if (
        !fs.existsSync(
            FIREFOX_EXECUTABLE
        )
    ) {

        log(
            "错误：Firefox 可执行文件不存在"
        );

        return false;
    }

    const stat =
        fs.statSync(
            FIREFOX_EXECUTABLE
        );

    log(
        "Firefox 文件大小：",
        stat.size,
        "bytes"
    );

    try {

        fs.chmodSync(
            FIREFOX_EXECUTABLE,
            0o755
        );

    } catch (error) {

        log(
            "chmod Firefox 失败：",
            error.message
        );
    }

    // --------------------------------------------------------
    // file
    // --------------------------------------------------------

    if (
        commandExists("file")
    ) {

        try {

            const result =
                execFileSync(
                    "file",
                    [
                        FIREFOX_EXECUTABLE
                    ],
                    {
                        encoding:
                            "utf8"
                    }
                );

            log(
                "file：",
                result.trim()
            );

        } catch (error) {

            log(
                "file 检查失败：",
                error.message
            );
        }
    }

    // --------------------------------------------------------
    // ldd
    // --------------------------------------------------------

    if (
        commandExists("ldd")
    ) {

        try {

            const result =
                execFileSync(
                    "ldd",
                    [
                        FIREFOX_EXECUTABLE
                    ],
                    {
                        encoding:
                            "utf8"
                    }
                );

            log(
                "Firefox 动态库："
            );

            console.log(
                result
            );

        } catch (error) {

            log(
                "ldd 检查失败：",
                error.stdout ||
                error.message
            );
        }
    }

    return true;
}


// ============================================================
// 安装 Firefox
// ============================================================

async function installFirefox() {

    if (
        fs.existsSync(
            FIREFOX_EXECUTABLE
        )
    ) {

        log(
            "Firefox 已经存在"
        );

        inspectFirefox();

        return;
    }

    log(
        "Firefox %s 安装开始",
        FIREFOX_VERSION
    );

    fs.mkdirSync(
        FIREFOX_DIR,
        {
            recursive: true
        }
    );

    const archive =
        path.join(
            "/tmp",
            "firefox-" +
            FIREFOX_VERSION +
            ".tar.xz"
        );

    log(
        "正在下载 Firefox..."
    );

    log(
        DOWNLOAD_URL
    );

    await downloadFile(
        DOWNLOAD_URL,
        archive
    );

    log(
        "Firefox 下载完成：",
        fs.statSync(
            archive
        ).size,
        "bytes"
    );

    // --------------------------------------------------------
    // 检查 tar
    // --------------------------------------------------------

    if (
        !commandExists("tar")
    ) {

        throw new Error(
            "系统没有 tar"
        );
    }

    log(
        "正在解压 Firefox..."
    );

    try {

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

    } catch (error) {

        throw new Error(
            "Firefox 解压失败：" +
            error.message
        );
    }

    try {

        fs.unlinkSync(
            archive
        );

    } catch (_) {}

    log(
        "Firefox 解压完成"
    );

    if (
        !fs.existsSync(
            FIREFOX_EXECUTABLE
        )
    ) {

        throw new Error(
            "Firefox 解压后找不到：" +
            FIREFOX_EXECUTABLE
        );
    }

    try {

        fs.chmodSync(
            FIREFOX_EXECUTABLE,
            0o755
        );

    } catch (_) {}

    inspectFirefox();

    log(
        "Firefox 实际可执行文件：",
        FIREFOX_EXECUTABLE
    );
}


// ============================================================
// 获取 Firefox 版本
// ============================================================

function getFirefoxVersion() {

    try {

        const result =
            execFileSync(
                FIREFOX_EXECUTABLE,
                [
                    "--version"
                ],
                {
                    encoding:
                        "utf8",
                    timeout:
                        15000,
                    env: {
                        ...process.env,
                        HOME: "/tmp"
                    }
                }
            );

        return result.trim();

    } catch (error) {

        log(
            "Firefox --version 失败"
        );

        if (
            error.stdout
        ) {
            log(
                "stdout：",
                error.stdout.toString()
            );
        }

        if (
            error.stderr
        ) {
            log(
                "stderr：",
                error.stderr.toString()
            );
        }

        log(
            "错误：",
            error.message
        );

        return null;
    }
}


// ============================================================
// 启动 Firefox
// ============================================================

function startFirefox() {

    if (
        firefoxProcess &&
        !firefoxProcess.killed
    ) {

        log(
            "Firefox 已经启动"
        );

        return;
    }

    if (
        !fs.existsSync(
            FIREFOX_EXECUTABLE
        )
    ) {

        throw new Error(
            "Firefox executable 不存在"
        );
    }

    fs.mkdirSync(
        PROFILE_DIR,
        {
            recursive: true
        }
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
        "正在启动 Firefox Headless..."
    );

    log(
        "Firefox 文件路径：",
        FIREFOX_EXECUTABLE
    );

    log(
        "启动参数：",
        JSON.stringify(args)
    );

    firefoxProcess =
        spawn(
            FIREFOX_EXECUTABLE,
            args,
            {
                cwd:
                    FIREFOX_DIR,
                env: {
                    ...process.env,

                    HOME:
                        "/tmp",

                    MOZ_HEADLESS:
                        "1",

                    DISPLAY:
                        ""
                },
                stdio: [
                    "ignore",
                    "pipe",
                    "pipe"
                ]
            }
        );

    firefoxState.running =
        true;

    firefoxState.error =
        null;

    firefoxState.pid =
        firefoxProcess.pid;

    firefoxState.startedAt =
        new Date().toISOString();

    firefoxProcess.stdout.on(
        "data",
        data => {

            console.log(
                "[Firefox stdout]",
                data.toString()
            );
        }
    );

    firefoxProcess.stderr.on(
        "data",
        data => {

            console.log(
                "[Firefox stderr]",
                data.toString()
            );
        }
    );

    firefoxProcess.on(
        "error",
        error => {

            firefoxState.running =
                false;

            firefoxState.error =
                error.message;

            log(
                "Firefox 启动失败：",
                error
            );

            if (
                error.code === "ENOENT"
            ) {

                log("");
                log(
                    "======================================"
                );
                log(
                    "Firefox ENOENT 诊断"
                );
                log(
                    "======================================"
                );

                log(
                    "文件：",
                    FIREFOX_EXECUTABLE
                );

                log(
                    "exists：",
                    fs.existsSync(
                        FIREFOX_EXECUTABLE
                    )
                );

                log(
                    "目录：",
                    FIREFOX_DIR
                );

                log(
                    "系统：",
                    os.platform(),
                    os.arch()
                );

                log(
                    "注意："
                );

                log(
                    "如果文件存在但 spawn 仍然 ENOENT，"
                );

                log(
                    "通常意味着 ELF 动态加载器或依赖库缺失。"
                );

                inspectFirefox();
            }
        }
    );

    firefoxProcess.on(
        "exit",
        (
            code,
            signal
        ) => {

            firefoxState.running =
                false;

            firefoxState.pid =
                null;

            log(
                "Firefox 退出：",
                {
                    code,
                    signal
                }
            );

            firefoxProcess =
                null;
        }
    );

    log(
        "Firefox Headless 启动命令已经执行"
    );
}


// ============================================================
// HTTP API
// ============================================================

function sendJSON(
    response,
    status,
    data
) {

    const body =
        JSON.stringify(
            data,
            null,
            2
        );

    response.writeHead(
        status,
        {
            "Content-Type":
                "application/json; charset=utf-8",

            "Content-Length":
                Buffer.byteLength(
                    body
                ),

            "Cache-Control":
                "no-store"
        }
    );

    response.end(
        body
    );
}


function serverHandler(
    request,
    response
) {

    const url =
        new URL(
            request.url,
            "http://127.0.0.1"
        );

    if (
        url.pathname === "/"
    ) {

        sendJSON(
            response,
            200,
            {
                status: "ok",
                browser: "Firefox",
                version:
                    FIREFOX_VERSION,
                running:
                    firefoxState.running,
                port: PORT,
                executable:
                    FIREFOX_EXECUTABLE,
                architecture:
                    process.arch,
                node:
                    process.version,
                profile:
                    PROFILE_DIR,
                pid:
                    firefoxState.pid,
                startedAt:
                    firefoxState.startedAt,
                error:
                    firefoxState.error
            }
        );

        return;
    }

    if (
        url.pathname === "/health"
    ) {

        sendJSON(
            response,
            firefoxState.running
                ? 200
                : 503,
            {
                status:
                    firefoxState.running
                        ? "running"
                        : "stopped",
                browser:
                    "Firefox",
                version:
                    FIREFOX_VERSION,
                pid:
                    firefoxState.pid,
                error:
                    firefoxState.error
            }
        );

        return;
    }

    if (
        url.pathname === "/version"
    ) {

        sendJSON(
            response,
            200,
            {
                firefox:
                    getFirefoxVersion(),
                executable:
                    FIREFOX_EXECUTABLE
            }
        );

        return;
    }

    if (
        url.pathname === "/restart"
    ) {

        try {

            if (
                firefoxProcess
            ) {

                firefoxProcess.kill(
                    "SIGTERM"
                );
            }

            setTimeout(
                () => {

                    try {

                        startFirefox();

                    } catch (error) {

                        log(
                            "重启 Firefox 失败：",
                            error.message
                        );
                    }

                },
                1000
            );

            sendJSON(
                response,
                200,
                {
                    status:
                        "restart requested"
                }
            );

        } catch (error) {

            sendJSON(
                response,
                500,
                {
                    status:
                        "error",
                    error:
                        error.message
                }
            );
        }

        return;
    }

    sendJSON(
        response,
        404,
        {
            status:
                "not found"
        }
    );
}


// ============================================================
// 启动 HTTP
// ============================================================

async function main() {

    console.log("");
    console.log(
        "======================================"
    );
    console.log(
        "Firefox + Unikraft Cloud"
    );
    console.log(
        "======================================"
    );

    log(
        "Node.js：",
        process.version
    );

    log(
        "架构：",
        process.arch
    );

    log(
        "平台：",
        process.platform
    );

    log(
        "Firefox 版本：",
        FIREFOX_VERSION
    );

    log(
        "Firefox 目录：",
        FIREFOX_DIR
    );

    log(
        "Profile：",
        PROFILE_DIR
    );

    log(
        "PORT：",
        PORT
    );

    // --------------------------------------------------------
    // HTTP 先启动
    // --------------------------------------------------------

    const server =
        http.createServer(
            serverHandler
        );

    server.listen(
        PORT,
        "0.0.0.0",
        () => {

            log(
                "HTTP 服务监听：0.0.0.0:" +
                PORT
            );
        }
    );

    // --------------------------------------------------------
    // 安装 Firefox
    // --------------------------------------------------------

    try {

        await installFirefox();

        const version =
            getFirefoxVersion();

        if (version) {

            log(
                "Firefox 实际版本：",
                version
            );

        }

    } catch (error) {

        firefoxState.error =
            error.message;

        log(
            "Firefox 安装失败：",
            error
        );

        return;
    }

    // --------------------------------------------------------
    // 启动 Firefox
    // --------------------------------------------------------

    try {

        startFirefox();

    } catch (error) {

        firefoxState.running =
            false;

        firefoxState.error =
            error.message;

        log(
            "Firefox 启动失败：",
            error
        );
    }
}


// ============================================================
// SIGTERM / SIGINT
// ============================================================

function shutdown(
    signal
) {

    log(
        "收到 %s，正在关闭...",
        signal
    );

    if (
        firefoxProcess
    ) {

        try {

            firefoxProcess.kill(
                "SIGTERM"
            );

        } catch (_) {}
    }

    process.exit(
        0
    );
}


process.on(
    "SIGTERM",
    () => shutdown("SIGTERM")
);

process.on(
    "SIGINT",
    () => shutdown("SIGINT")
);


process.on(
    "uncaughtException",
    error => {

        console.error(
            "[Fatal]",
            error
        );
    }
);


process.on(
    "unhandledRejection",
    error => {

        console.error(
            "[Unhandled]",
            error
        );
    }
);


// ============================================================
// 启动
// ============================================================

main().catch(
    error => {

        console.error(
            "[Fatal]",
            error
        );
    }
);
