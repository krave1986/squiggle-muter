// scripts/compress-images.js
//
// ─── 运行要求 ────────────────────────────────────────────────────────────────
//
// 本脚本必须通过 npm scripts 执行（如 npm run compress:images）。
// npm 在执行脚本时，会自动注入 npm_config_local_prefix 环境变量，
// 其值就是 package.json 所在的项目根目录。
//
// 不能直接用 node scripts/compress-images.js 执行，
// 也不能在 VSCode 调试时直接 F5，除非在 launch.json 中手动注入该环境变量。
//
// ─── 设计目标 ────────────────────────────────────────────────────────────────
//
// 找出 images/ 目录下所有超过阈值的 PNG 文件，压缩后覆盖原文件。
// 压缩前把原图备份到同目录的 .originals/ 子目录里。
// 已经合格的文件直接跳过，脚本可重复运行。
// 备份文件会被覆盖，确保更新图片后备份始终是最新原图。
//
// ─── 执行模型 ────────────────────────────────────────────────────────────────
//
// 主流程分两层：
//
// 【可控层】for await...of 迭代 glob()，串行消费 AsyncIterator。
//   glob 是流式的，找到一个条目就 yield 一个，内存占用接近常数。
//   for await...of 在等待 iterator.next() resolve 时是唯一的等待点。
//   循环体内所有 IO 操作全部用 .then()/.catch() 挂载，不 await，
//   挂完立刻返回，进入下一次迭代。
//
// 【委托层】sharp 的压缩任务被派发给 Node.js 事件循环，完全不 await。
//   sharp 底层基于 libvips，内部多线程，多个任务真正并发运行。
//   Node.js 进程在所有挂载的 .then()/.catch() 回调执行完之前不会退出，
//   所以不需要 Promise.all 来"保活"——事件队列不空，进程就继续运行。
//
// ─── .originals/ 目录的竞态分析 ─────────────────────────────────────────────
//
// glob 的返回顺序不保证，相邻两次迭代可能来自完全不同的目录。
// 不能假设"上一次迭代已经为某个目录创建好了 .originals/"。
//
// 解决方案：ensureOriginalsDir() 封装目录确认逻辑：
//   - Set 缓存已确认存在的目录，O(1) 查找，避免重复 IO
//   - 用 stat 区分"目录不存在（ENOENT）"和"权限不足（EACCES）"，
//     只有 ENOENT 才执行 mkdir，其他错误向上抛出
//   - 只有目录真正确认存在后，才把路径加进 Set，才执行后续的 copyFile
//   - 这样即使多次迭代并发命中同一目录，copyFile 也不会早于目录存在而执行
//
// ─── 路径构造 ────────────────────────────────────────────────────────────────
//
// 根目录来自 npm 注入的 npm_config_local_prefix 环境变量。
// 用 withFileTypes: true 让 glob 返回 Dirent 对象：
//   dirent.parentPath — 父目录的绝对路径字符串
//   dirent.name       — 文件名
// 两者直接 join，不需要基于 cwd 做二次拼接。
//
// ────────────────────────────────────────────────────────────────────────────

import sharp from "sharp";
import { glob, stat, mkdir, copyFile, rename } from "node:fs/promises";
import { join, relative } from "node:path";

// ─── 前置检查：确认运行环境 ──────────────────────────────────────────────────
//
// npm_config_local_prefix 只有在 npm run 执行时才会被注入。
// 没有这个变量，说明脚本被直接运行，无法确定项目根目录。
// 检查失败时立刻退出，避免后续因路径错误产生难以排查的问题。
const projectRoot = process.env.npm_config_local_prefix;

if (!projectRoot) {
    console.error(
        "Error: This script must be run via npm scripts (e.g. npm run compress:images).\n" +
            "It cannot be executed directly.\n\n" +
            "If you are debugging in VSCode, add the following to your launch.json:\n" +
            '  "env": { "npm_config_local_prefix": "${workspaceFolder}" }',
    );
    process.exit(1);
}

// 图片大小阈值：128 KB。
// 只有超过这个大小的图片才需要压缩。
const SIZE_THRESHOLD_BYTES = 128 * 1024;

// .originals/ 目录的名字。
// 点前缀表示这是工具生成的隐藏目录，不是开发者自己写的内容。
// 需要在 .vscodeignore 里加上 **/.originals 来排除打包。
const ORIGINALS_DIR_NAME = ".originals";

// images/ 目录的绝对路径。
// 基于 npm_config_local_prefix（项目根目录）构造，
// 不依赖 CWD，也不依赖脚本文件所在位置。
// 所以脚本移到任意子目录，路径依然正确。
const imagesDirPath = join(projectRoot, "images");

// 缓存"已确认存在的 .originals/ 目录"。
// key 是目录的绝对路径字符串。
// 只有目录真正确认存在后才加进 Set，保证后续 copyFile 不会早于目录执行。
const confirmedOriginalsDirs = new Set();

// 确保指定的 .originals/ 目录存在，并记录到 Set 缓存中。
// 直接尝试 mkdir，根据结果分三条路：
//   成功 → 目录刚被创建，加入 Set
//   EEXIST → 目录是上次运行留下的，文件系统有但 Set 没有，补录进 Set
//   其他错误（如 EACCES）→ 向上抛出
function ensureOriginalsDir(originalsDir) {
    // 如果集合中，原图目录已经存在，则直接返回 resolved promise，
    // 马上激活后续 .then() 中文件拷贝步骤。
    if (confirmedOriginalsDirs.has(originalsDir)) return Promise.resolve(); // 已确认存在，零 IO 直接返回
    return (
        mkdir(originalsDir)
            // 创建成功，加入 Set
            .then(() => confirmedOriginalsDirs.add(originalsDir))
            .catch((err) => {
                // 非 EEXIST 的真实错误，向上抛
                if (err.code !== "EEXIST") throw err;
                // 目录已存在，补录进 Set
                confirmedOriginalsDirs.add(originalsDir);
            })
    );
}

// 派发单个文件的压缩任务给 sharp，完全不 await。
//
// sharp 不支持原地覆盖（输入和输出不能是同一个路径），
// 所以先写到 .tmp 临时文件，压缩完成后用 rename 覆盖原文件。
// rename 在同一文件系统上是原子操作，不会出现中间状态。
//
// Node.js 进程在所有 .then()/.catch() 回调执行完之前不会退出，
// 所以不需要 Promise.all 来"保活"。
function dispatchToSharp(imageAbsolutePath, imageRelativePath) {
    // sharp 不支持原地覆盖，先输出到临时文件，完成后再 rename 覆盖原文件
    const tmpPath = imageAbsolutePath + ".tmp";

    sharp(imageAbsolutePath)
        .png({
            // zlib 压缩级别，0-9，9 是最高压缩率（文件最小，CPU 最慢）
            compressionLevel: 9,
            // sharp 内部压缩努力程度，1-10，10 是最大努力
            effort: 10,
            // 启用调色板模式（类似 PNG-8）。
            // 对颜色较少的图标效果显著，可压缩到原来的 20-50%
            palette: true,
            // 调色板模式下的颜色量化质量，0-100，值越低文件越小。
            // 40 是经验值：对图标类图片压缩率极高，肉眼几乎无感知差异。
            // 如视觉质量不满足要求，可适当调高，建议范围 40-80。
            quality: 40,
        })
        .toFile(tmpPath)
        // 压缩写入 .tmp 完成，用 rename 原子覆盖原文件
        .then(() => rename(tmpPath, imageAbsolutePath))
        // 覆盖完成，读取新文件大小并打印日志
        .then(() =>
            stat(imageAbsolutePath).then(({ size: newSize }) => {
                console.log(
                    `  ✅ 压缩完成：${imageRelativePath}（→ ${(newSize / 1024).toFixed(1)} KB）`,
                );
            }),
        )
        .catch((err) =>
            console.error(`  ❌ 压缩失败：${imageRelativePath}`, err),
        );
}

// glob 是 Node.js 22 引入的原生文件模式匹配 API，返回 AsyncIterator。
// "**/*.png" 递归匹配所有层级的 PNG 文件。
// cwd 指定搜索起点为 images/ 目录。
// withFileTypes: true 让 glob 返回 Dirent 对象，
//   直接提供父目录绝对路径和文件名，不需要基于 cwd 做二次拼接。
// exclude: ["**/.originals"] 匹配 .originals 目录本身，
//   原生引擎遇到该目录时直接跳过 readdir，不进入，
//   比 "**/.originals/**" 少一次无意义的 readdir IO。
//
// for await...of 串行消费 AsyncIterator：
//   每次循环等待 iterator.next() resolve（等 glob 找到下一个文件），
//   这是唯一的、逻辑上不可绕过的等待点。
//   循环体内不 await 任何操作，挂完 .then() 立刻进入下一次迭代。
for await (const dirent of glob("**/*.png", {
    cwd: imagesDirPath,
    withFileTypes: true,
    exclude: ["**/.originals"],
})) {
    // dirent.parentPath 是父目录的绝对路径字符串
    // dirent.name 是文件名
    // 两者直接 join，得到文件的绝对路径
    const imageAbsolutePath = join(dirent.parentPath, dirent.name);

    // .originals/ 目录和备份文件路径，同样基于 Dirent 直接构造
    const originalsDir = join(dirent.parentPath, ORIGINALS_DIR_NAME);
    const backupPath = join(originalsDir, dirent.name);

    // 文件相对于项目根目录的相对路径
    // 纯粹是为了在打印日志时，能够有更好的体验
    const imageRelativePath = relative(projectRoot, imageAbsolutePath);

    // stat 是异步的，不 await，直接挂 .then()。
    // 挂完立刻返回，for await...of 进入下一次 iterator.next()。
    stat(imageAbsolutePath)
        .then(({ size }) => {
            // 文件大小在阈值以内，说明已压缩过，跳过。
            if (size <= SIZE_THRESHOLD_BYTES) {
                console.log(
                    `✅ 跳过（已合格）：${imageRelativePath}（${(size / 1024).toFixed(1)} KB）`,
                );
                return;
            }

            console.log(
                `⚠️  需要压缩：${imageRelativePath}（${(size / 1024).toFixed(1)} KB）`,
            );

            // ensureOriginalsDir 确认目录存在后才执行 copyFile，
            // 避免"目录还没创建好就开始写入"的竞态。
            ensureOriginalsDir(originalsDir)
                .then(() => copyFile(imageAbsolutePath, backupPath))
                .then(() => {
                    // 备份完成，把压缩任务派发给 sharp，完全不 await
                    dispatchToSharp(imageAbsolutePath, imageRelativePath);
                })
                .catch((err) =>
                    console.error(`  ❌ 备份失败：${imageRelativePath}`, err),
                );
        })
        .catch((err) =>
            console.error(`❌ 读取文件信息失败：${imageRelativePath}`, err),
        );
}

// 主流程到这里执行完毕。
// 此时所有 stat、copyFile、sharp 的异步任务仍在事件队列中运行。
// Node.js 不会退出，直到所有 .then()/.catch() 回调全部执行完毕。
console.log("📋 所有文件已扫描完毕，压缩任务正在后台运行...");
