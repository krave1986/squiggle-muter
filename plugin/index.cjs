// 要屏蔽的错误码列表。
// 放在模块顶层，create 和 onConfigurationChanged 共享同一份引用。
let suppressedCodes = [];

function init() {
    let logger = null; // 等 create() 被调用后才能拿到

    return {
        create(info) {
            // 给 logger 变量做初始化赋值
            logger = info.project.projectService.logger;
            // 通过日志文件对 plugin 进行调试
            info.project.projectService.logger.info(
                ">>> Squiggle Muter 已加载！",
            );

            // 1. 创建一个代理对象，把原始的 语言服务实例 上的所有方法都拷贝到代理对象上
            //    通过 Object.create(null) 创建的对象没有原型链，非常干净
            const proxyLanguageService = Object.create(null);
            // 获取原始的 语言服务实例
            const oldLanguageServiceInstance = info.languageService;

            for (const k of Object.keys(oldLanguageServiceInstance)) {
                proxyLanguageService[k] = oldLanguageServiceInstance[k].bind(
                    oldLanguageServiceInstance,
                );
            }

            // 2. 覆盖 getSemanticDiagnostics，过滤红波浪线（语义错误）
            //    防御性过滤，以防某些 code 同时出现在语义错误里
            proxyLanguageService.getSemanticDiagnostics = (fileName) => {
                return oldLanguageServiceInstance
                    .getSemanticDiagnostics(fileName)
                    .filter((d) => !suppressedCodes.includes(d.code));
            };

            // 3. 覆盖 getSuggestionDiagnostics，过滤灰色三点（建议提示）
            //    7044 等大多数"烦人"的提示实际上都归这个方法管
            proxyLanguageService.getSuggestionDiagnostics = (fileName) => {
                return oldLanguageServiceInstance
                    .getSuggestionDiagnostics(fileName)
                    .filter((d) => !suppressedCodes.includes(d.code));
            };

            return proxyLanguageService;
        },

        // 当 extension.js 通过 VSCode API 推送用户配置时，tsserver 会调用这个方法
        onConfigurationChanged(config) {
            if (Array.isArray(config.suppressedCodes)) {
                suppressedCodes = config.suppressedCodes;
                // 成功收到配置，打印一行确认
                if (logger) {
                    logger.info(
                        `>>> Squiggle Muter: 收到配置 suppressedCodes = ${JSON.stringify(suppressedCodes)}`,
                    );
                }
            } else if (logger) {
                logger.info(
                    `>>> Squiggle Muter: suppressedCodes 配置格式错误，期望数组，收到 ${typeof config.suppressedCodes}，已忽略。`,
                );
            }
        },
    };
}

module.exports = init;
