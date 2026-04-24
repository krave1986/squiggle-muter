// vscode 是一个虚模块（virtual module），不存在于 npm registry，也不在 node_modules 里。
// 它由 VSCode 的 Extension Host 进程在运行时直接注入。
// 所以不需要 npm install vscode，但只能在 Extension Host 进程里使用，
// 不能在 plugin/index.cjs（tsserver 进程）里使用。
import * as vscode from "vscode";

// activate() 是固定的入口函数名，VSCode 激活这个 extension 时调用。
// 激活的时机由 package.json 的 activationEvents 字段决定。
// 我们配置了 "onLanguage:javascript"，所以用户打开 .js 文件时激活。
// 一旦激活，activate() 只会被调用一次，之后 extension 一直保持激活状态。
// context 是 VSCode 传进来的上下文对象，包含 subscriptions 等生命周期工具。
export function activate(context) {
    // 获取 VSCode 内置的 TypeScript extension 实例。
    // 我们无法直接和 tsserver 通信，必须通过这个 extension 作为中间层。
    // 它负责启动 tsserver、管理 plugin 的加载，以及把我们的配置推送给 plugin。
    const builtinTSExtension = vscode.extensions.getExtension(
        "vscode.typescript-language-features",
    );

    // 防御性检查。正常情况下这个内置 extension 一定存在，但以防万一。
    if (!builtinTSExtension) {
        vscode.window.showErrorMessage(
            "Squiggle Muter: Built-in TypeScript extension (vscode.typescript-language-features) not found. The plugin cannot work.",
        );
        return;
    }

    // TypeScript extension 可能还没有激活，activate() 确保它就绪后再拿 API。
    // 返回的 api 是 TypeScript extension 暴露出来的公共接口对象。
    builtinTSExtension.activate().then((api) => {
        if (!api) {
            vscode.window.showErrorMessage(
                "Squiggle Muter: Failed to get the TypeScript extension API. The plugin cannot work.",
            );
            return;
        }

        // 拿到 TypeScript extension API 的第 0 版本。
        // 目前只有版本 0，这是固定写法。
        const pluginApi = api.getAPI(0);
        if (!pluginApi) {
            vscode.window.showErrorMessage(
                "Squiggle Muter: Failed to get the TypeScript extension plugin API. The plugin cannot work.",
            );
            return;
        }

        // 读取用户配置，推送给 plugin。
        // 封装成函数是因为有两个地方需要调用：
        // 1. extension 激活时主动推送一次
        // 2. 用户修改 settings.json 时重新推送
        function pushConfig() {
            // 读取 settings.json 里以 squiggleMuter 开头的配置块。
            const configFromUserSettings =
                vscode.workspace.getConfiguration("squiggleMuter");

            // 读取 squiggleMuter.suppressedCodes 的值。
            // 第二个参数是读不到时的兜底默认值，与 plugin/index.cjs 顶层的默认值保持一致。
            const suppressedCodes = configFromUserSettings.get(
                "suppressedCodes",
                [],
            );

            // 把配置推送给 tsserver plugin。
            // 第一个参数是 plugin 的名字，必须与 package.json 里
            // contributes.typescriptServerPlugins.0.name 字段的值完全一致。
            // TypeScript extension 收到后，会调用 plugin 的 onConfigurationChanged()。
            pluginApi.configurePlugin("squiggle-muter-plugin", {
                suppressedCodes,
            });

            // 让 tsserver 立即重新诊断所有已打开的文件
            setTimeout(() => {
                vscode.commands.executeCommand("javascript.reloadProjects");
            }, 0);
        }

        // extension 激活时主动推送一次。
        // 确保 tsserver 启动后立刻拿到用户配置，而不是停在 plugin 里的默认值上。
        pushConfig();

        // 注册监听器，用户每次保存 settings.json 时触发。
        const disposable = vscode.workspace.onDidChangeConfiguration(
            (event) => {
                // 检查这次变动是否涉及我们的配置项。
                // 用户可能改了其他 extension 的设置，那种情况不需要推送。
                if (event.affectsConfiguration("squiggleMuter")) {
                    pushConfig();
                }
            },
        );

        // 把监听器的销毁句柄交给 VSCode 管理。
        // extension 停用时，VSCode 会自动调用 disposable.dispose()，
        // 清理监听器，防止内存泄漏。
        context.subscriptions.push(disposable);
    });
}

// 固定的退出函数名，extension 停用时调用（比如 VSCode 关闭时）。
// 我们没有需要手动清理的资源（已经交给 subscriptions 管理了），
// 所以函数体为空。
// 如果清理逻辑是异步的，这个函数需要返回一个 Promise，VSCode 会等待它完成。
export function deactivate() {}
