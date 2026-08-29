'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile, spawn } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

/* ============================================================
 * 基础配置
 * ============================================================ */

const PORT = Number(process.env.PORT || 3000);

const APP_DIR = '/app';

const FIREFOX_DIR = path.join(APP_DIR, 'firefox');

const PROFILE_DIR = path.join(APP_DIR, 'firefox-profile');

const DOWNLOAD_DIR = path.join(APP_DIR, 'downloads');

let firefoxProcess = null;

let firefoxPath = null;

let firefoxVersion = 'unknown';

let firefoxRunning = false;

let firefoxError = null;

let installing = false;

/* ============================================================
 * 日志
 * ============================================================ */

function log(...args) {
    console.log('[Firefox]', ...args);
}

/* ============================================================
 * 创建目录
 * ============================================================ */

function ensureDirectories() {
    fs.mkdirSync(FIREFOX_DIR, { recursive: true });
    fs.mkdirSync(PROFILE_DIR, { recursive: true });
    fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
}

/* ============================================================
 * HTTP 下载
 * ============================================================ */

function downloadFile(url, destination) {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(destination);

        const request = https.get(
            url,
            {
                headers: {
                    'User-Agent': 'Mozilla/5.0 Firefox-Unikraft'
                }
            },
            response => {

                // HTTP 重定向
                if (
                    response.statusCode >= 300 &&
                    response.statusCode < 400 &&
                    response.headers.location
                ) {
                    file.close();

                    try {
                        fs.unlinkSync(destination);
                    } catch (_) {}

                    return downloadFile(
                        response.headers.location,
                        destination
                    )
                        .then(resolve)
                        .catch(reject);
                }

                if (response.statusCode !== 200) {
                    file.close();

                    try {
                        fs.unlinkSync(destination);
                    } catch (_) {}

                    return reject(
                        new Error(
                            `下载失败 HTTP ${response.statusCode}`
                        )
                    );
                }

                response.pipe(file);

                file.on('finish', () => {
                    file.close(() => resolve());
                });
            }
        );

        request.setTimeout(10 * 60 * 1000, () => {
            request.destroy(
                new Error('Firefox 下载超时')
            );
        });

        request.on('error', error => {
            file.close();

            try {
                fs.unlinkSync(destination);
            } catch (_) {}

            reject(error);
        });
    });
}

/* ============================================================
 * 获取 Firefox 最新版本
 * ============================================================ */

function getLatestFirefoxVersion() {
    return new Promise((resolve, reject) => {

        const url =
            'https://product-details.mozilla.org/1.0/firefox_versions.json';

        https.get(
            url,
            {
                headers: {
                    'User-Agent': 'Firefox-Unikraft'
                }
            },
            response => {

                let data = '';

                response.on('data', chunk => {
                    data += chunk;
                });

                response.on('end', () => {

                    try {

                        const json = JSON.parse(data);

                        const version =
                            json.LATEST_FIREFOX_VERSION;

                        if (!version) {
                            throw new Error(
                                '无法获取 Firefox 最新版本'
                            );
                        }

                        resolve(version);

                    } catch (error) {
                        reject(error);
                    }
                });
            }
        ).on('error', reject);
    });
}

/* ============================================================
 * 判断文件是否为 Firefox 可执行文件
 * ============================================================ */

function isFirefoxExecutable(file) {

    try {

        if (!fs.statSync(file).isFile()) {
            return false;
        }

        const base = path.basename(file).toLowerCase();

        if (
            base !== 'firefox' &&
            base !== 'firefox-bin'
        ) {
            return false;
        }

        fs.accessSync(
            file,
            fs.constants.X_OK
        );

        return true;

    } catch (_) {

        return false;
    }
}

/* ============================================================
 * 递归寻找 Firefox
 * ============================================================ */

function findFirefoxExecutable(root) {

    if (!fs.existsSync(root)) {
        return null;
    }

    const queue = [root];

    while (queue.length > 0) {

        const current = queue.shift();

        let entries;

        try {
            entries = fs.readdirSync(
                current,
                {
                    withFileTypes: true
                }
            );
        } catch (_) {
            continue;
        }

        for (const entry of entries) {

            const fullPath =
                path.join(
                    current,
                    entry.name
                );

            if (entry.isDirectory()) {

                // 不扫描 profile 和 downloads
                if (
                    fullPath === PROFILE_DIR ||
                    fullPath === DOWNLOAD_DIR
                ) {
                    continue;
                }

                queue.push(fullPath);

                continue;
            }

            if (isFirefoxExecutable(fullPath)) {

                return fullPath;
            }
        }
    }

    return null;
}

/* ============================================================
 * 修复 Firefox 权限
 * ============================================================ */

function fixFirefoxPermissions(root) {

    if (!fs.existsSync(root)) {
        return;
    }

    const queue = [root];

    while (queue.length > 0) {

        const current = queue.shift();

        let entries;

        try {
            entries = fs.readdirSync(
                current,
                {
                    withFileTypes: true
                }
            );
        } catch (_) {
            continue;
        }

        for (const entry of entries) {

            const fullPath =
                path.join(
                    current,
                    entry.name
                );

            if (entry.isDirectory()) {

                queue.push(fullPath);

            } else if (
                entry.name === 'firefox' ||
                entry.name === 'firefox-bin'
            ) {

                try {
                    fs.chmodSync(
                        fullPath,
                        0o755
                    );
                } catch (_) {}
            }
        }
    }
}

/* ============================================================
 * 显示 Firefox 目录
 * ============================================================ */

function printFirefoxDirectory() {

    log('Firefox 安装目录检查：');

    try {

        const result = [];

        function walk(dir, depth) {

            if (depth > 4) {
                return;
            }

            let entries;

            try {
                entries = fs.readdirSync(
                    dir,
                    {
                        withFileTypes: true
                    }
                );
            } catch (_) {
                return;
            }

            for (const entry of entries) {

                const full =
                    path.join(
                        dir,
                        entry.name
                    );

                result.push(full);

                if (entry.isDirectory()) {
                    walk(full, depth + 1);
                }
            }
        }

        walk(FIREFOX_DIR, 0);

        for (const item of result.slice(0, 150)) {
            console.log(item);
        }

    } catch (error) {

        log(
            '无法读取 Firefox 目录：',
            error.message
        );
    }
}

/* ============================================================
 * 解压 Firefox
 * ============================================================ */

async function extractFirefox(archive) {

    log('正在解压 Firefox...');

    // 先尝试 tar
    try {

        await execFileAsync(
            'tar',
            [
                '-xJf',
                archive,
                '-C',
                FIREFOX_DIR
            ],
            {
                timeout: 5 * 60 * 1000
            }
        );

        return;

    } catch (error) {

        log(
            'tar -xJf 解压失败：',
            error.message
        );
    }

    // 如果系统 tar 不支持 xz，
    // 尝试使用 xz + tar
    try {

        await execFileAsync(
            'sh',
            [
                '-c',
                `xz -dc "${archive}" | tar -xf - -C "${FIREFOX_DIR}"`
            ],
            {
                timeout: 5 * 60 * 1000
            }
        );

        return;

    } catch (error) {

        throw new Error(
            `Firefox 解压失败：${error.message}`
        );
    }
}

/* ============================================================
 * 下载并安装 Firefox
 * ============================================================ */

async function installFirefox() {

    if (installing) {
        return;
    }

    installing = true;

    try {

        ensureDirectories();

        log('系统架构：', os.arch());

        if (os.arch() !== 'x64') {

            throw new Error(
                `当前架构 ${os.arch()}，此版本程序只支持 x64 Firefox`
            );
        }

        // ----------------------------------------------------
        // 如果之前已经安装，直接寻找
        // ----------------------------------------------------

        let existing =
            findFirefoxExecutable(FIREFOX_DIR);

        if (existing) {

            firefoxPath = existing;

            log(
                '发现已经安装的 Firefox：',
                firefoxPath
            );

            await detectFirefoxVersion();

            return;
        }

        // ----------------------------------------------------
        // 获取最新版本
        // ----------------------------------------------------

        log('正在获取 Firefox 最新版本...');

        const version =
            await getLatestFirefoxVersion();

        firefoxVersion = version;

        log(
            'Mozilla 最新 Firefox：',
            version
        );

        // ----------------------------------------------------
        // Firefox 官方 x64 Linux
        // ----------------------------------------------------

        const url =
            `https://ftp.mozilla.org/pub/firefox/releases/${version}/linux-x86_64/en-US/firefox-${version}.tar.xz`;

        const archive =
            path.join(
                DOWNLOAD_DIR,
                `firefox-${version}.tar.xz`
            );

        log(
            '正在下载 Firefox',
            version
        );

        log(url);

        await downloadFile(
            url,
            archive
        );

        const size =
            fs.statSync(archive).size;

        log(
            `下载完成：${(size / 1024 / 1024).toFixed(2)} MB`
        );

        // ----------------------------------------------------
        // 解压
        // ----------------------------------------------------

        await extractFirefox(
            archive
        );

        // ----------------------------------------------------
        // 修复权限
        // ----------------------------------------------------

        fixFirefoxPermissions(
            FIREFOX_DIR
        );

        // ----------------------------------------------------
        // 自动寻找真正 executable
        // ----------------------------------------------------

        existing =
            findFirefoxExecutable(
                FIREFOX_DIR
            );

        if (!existing) {

            printFirefoxDirectory();

            throw new Error(
                'Firefox 解压完成，但没有找到 firefox 可执行文件'
            );
        }

        firefoxPath = existing;

        log(
            'Firefox 实际可执行文件：',
            firefoxPath
        );

        // ----------------------------------------------------
        // 删除安装包，节省空间
        // ----------------------------------------------------

        try {
            fs.unlinkSync(archive);
        } catch (_) {}

        await detectFirefoxVersion();

        log(
            `Firefox ${firefoxVersion} 安装完成`
        );

    } finally {

        installing = false;
    }
}

/* ============================================================
 * 检测 Firefox 版本
 * ============================================================ */

async function detectFirefoxVersion() {

    if (!firefoxPath) {
        return;
    }

    try {

        const result =
            await execFileAsync(
                firefoxPath,
                [
                    '--version'
                ],
                {
                    timeout: 30000
                }
            );

        const output =
            `${result.stdout || ''}${result.stderr || ''}`
                .trim();

        const match =
            output.match(
                /Firefox\s+([0-9.]+)/
            );

        if (match) {

            firefoxVersion =
                match[1];

        } else if (output) {

            firefoxVersion =
                output;
        }

    } catch (error) {

        log(
            '获取 Firefox 版本失败：',
            error.message
        );
    }
}

/* ============================================================
 * 启动 Firefox
 * ============================================================ */

async function startFirefox() {

    if (firefoxRunning) {
        return;
    }

    try {

        if (!firefoxPath) {

            firefoxPath =
                findFirefoxExecutable(
                    FIREFOX_DIR
                );
        }

        if (!firefoxPath) {

            await installFirefox();

            firefoxPath =
                findFirefoxExecutable(
                    FIREFOX_DIR
                );
        }

        if (!firefoxPath) {

            throw new Error(
                '安装后仍然找不到 Firefox'
            );
        }

        // ----------------------------------------------------
        // 确保 profile 存在
        // ----------------------------------------------------

        fs.mkdirSync(
            PROFILE_DIR,
            {
                recursive: true
            }
        );

        log(
            'Firefox 文件路径：',
            firefoxPath
        );

        log(
            '正在启动 Firefox Headless...'
        );

        const args = [
            '--headless',
            '--no-remote',
            '--profile',
            PROFILE_DIR,
            '--width',
            '1280',
            '--height',
            '720',
            'about:blank'
        ];

        log(
            '启动参数：',
            JSON.stringify(args)
        );

        firefoxProcess =
            spawn(
                firefoxPath,
                args,
                {
                    detached: false,
                    stdio: [
                        'ignore',
                        'pipe',
                        'pipe'
                    ],
                    env: {
                        ...process.env,
                        HOME: APP_DIR,
                        DISPLAY: ''
                    }
                }
            );

        firefoxProcess.stdout.on(
            'data',
            data => {
                console.log(
                    '[Firefox stdout]',
                    data.toString().trim()
                );
            }
        );

        firefoxProcess.stderr.on(
            'data',
            data => {
                console.log(
                    '[Firefox stderr]',
                    data.toString().trim()
                );
            }
        );

        firefoxProcess.on(
            'error',
            error => {

                firefoxRunning = false;

                firefoxError =
                    error.message;

                log(
                    '启动 Firefox 失败：',
                    error
                );
            }
        );

        firefoxProcess.on(
            'exit',
            (code, signal) => {

                firefoxRunning = false;

                log(
                    `Firefox 退出 code=${code} signal=${signal}`
                );

                firefoxProcess = null;
            }
        );

        firefoxRunning = true;

        firefoxError = null;

        log(
            'Firefox Headless 启动命令已经执行'
        );

    } catch (error) {

        firefoxRunning = false;

        firefoxError =
            error.message;

        log(
            '启动失败：',
            error
        );
    }
}

/* ============================================================
 * Firefox 状态
 * ============================================================ */

function getStatus() {

    return {
        status: 'ok',
        browser: 'Firefox',
        version: firefoxVersion,
        running: firefoxRunning,
        port: PORT,
        executable:
            firefoxPath || null,
        architecture:
            os.arch(),
        node:
            process.version,
        profile:
            PROFILE_DIR,
        error:
            firefoxError
    };
}

/* ============================================================
 * HTTP 服务
 * ============================================================ */

const server =
    http.createServer(
        async (req, res) => {

            const url =
                new URL(
                    req.url,
                    `http://${req.headers.host || 'localhost'}`
                );

            // ------------------------------------------------
            // CORS
            // ------------------------------------------------

            res.setHeader(
                'Access-Control-Allow-Origin',
                '*'
            );

            res.setHeader(
                'Content-Type',
                'application/json; charset=utf-8'
            );

            // ------------------------------------------------
            // 首页
            // ------------------------------------------------

            if (
                url.pathname === '/' ||
                url.pathname === '/status'
            ) {

                res.writeHead(200);

                res.end(
                    JSON.stringify(
                        getStatus(),
                        null,
                        2
                    )
                );

                return;
            }

            // ------------------------------------------------
            // Health check
            // ------------------------------------------------

            if (url.pathname === '/health') {

                const healthy =
                    firefoxRunning;

                res.writeHead(
                    healthy ? 200 : 503
                );

                res.end(
                    JSON.stringify(
                        {
                            status:
                                healthy
                                    ? 'ok'
                                    : 'starting',
                            firefox:
                                firefoxRunning
                        },
                        null,
                        2
                    )
                );

                return;
            }

            // ------------------------------------------------
            // 启动 Firefox
            // ------------------------------------------------

            if (
                url.pathname === '/start'
            ) {

                await startFirefox();

                res.writeHead(200);

                res.end(
                    JSON.stringify(
                        getStatus(),
                        null,
                        2
                    )
                );

                return;
            }

            // ------------------------------------------------
            // 404
            // ------------------------------------------------

            res.writeHead(404);

            res.end(
                JSON.stringify(
                    {
                        error:
                            'Not Found'
                    }
                )
            );
        }
    );

/* ============================================================
 * 启动 HTTP
 * ============================================================ */

server.listen(
    PORT,
    '0.0.0.0',
    () => {

        console.log(
            '======================================'
        );

        console.log(
            'Firefox + Unikraft Cloud'
        );

        console.log(
            '======================================'
        );

        log(
            'HTTP 服务监听：0.0.0.0:' + PORT
        );

        log(
            '架构：',
            os.arch()
        );

        log(
            'Node.js：',
            process.version
        );

        log(
            'Firefox 目录：',
            FIREFOX_DIR
        );

        log(
            'Profile：',
            PROFILE_DIR
        );

        // ----------------------------------------------------
        // HTTP 服务启动后再安装 Firefox
        // 不阻塞端口
        // ----------------------------------------------------

        setTimeout(
            async () => {

                try {

                    await installFirefox();

                    await startFirefox();

                } catch (error) {

                    firefoxError =
                        error.message;

                    log(
                        'Firefox 初始化失败：',
                        error
                    );

                    // 不退出 Node
                    // 保证 Unikraft 实例不会因为 Firefox
                    // 初始化失败而直接停止

                }

            },
            500
        );
    }
);

/* ============================================================
 * 防止异常导致 Node 直接退出
 * ============================================================ */

process.on(
    'uncaughtException',
    error => {

        firefoxError =
            error.message;

        console.error(
            '[Firefox] uncaughtException:',
            error
        );
    }
);

process.on(
    'unhandledRejection',
    error => {

        firefoxError =
            error && error.message
                ? error.message
                : String(error);

        console.error(
            '[Firefox] unhandledRejection:',
            error
        );
    }
);

/* ============================================================
 * 优雅退出
 * ============================================================ */

function shutdown(signal) {

    log(
        `收到 ${signal}，正在关闭...`
    );

    if (firefoxProcess) {

        try {
            firefoxProcess.kill(
                'SIGTERM'
            );
        } catch (_) {}
    }

    server.close(
        () => {
            process.exit(0);
        }
    );

    setTimeout(
        () => process.exit(0),
        3000
    );
}

process.on(
    'SIGTERM',
    () => shutdown('SIGTERM')
);

process.on(
    'SIGINT',
    () => shutdown('SIGINT')
);
