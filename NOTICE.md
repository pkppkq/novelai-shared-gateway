# 第三方许可

本项目包含历史第三方基础代码，适用 MIT 许可。相关版权署名与完整许可原样保留在 `UPSTREAM-LICENSE`，用于履行代码许可义务。

历史第三方基础代码提供基础网关、NovelAI 请求适配、SQLite 存储、任务与图片处理。其原有 MIT 权利不受本项目非商用条款影响。

本项目新增共享额度账本、成员登录与管理、分组与权重分配、共享状态、严格共享路由、初始化脚本及文档，并修改了相关请求调度、计费、权限和页面。上述新增与修改部分适用根目录 `LICENSE` 的非商用源码许可，禁止未经许可的商用。**不能将整个混合项目描述为 MIT，也不能借本项目限制上游原版的 MIT 使用权。**

NovelAI 的名称、服务、订阅和模型属于相应权利人，本项目与其没有官方关联。

`test-support/msgpack.mjs` 是 `@msgpack/msgpack` 3.1.3 的独立解码器，用于验证原生流式响应，适用 ISC 许可，完整声明保留在 [test-support/msgpack.LICENSE.txt](test-support/msgpack.LICENSE.txt)。本项目的非商用条款不替代该第三方组件的许可。生产生图帧由 `server/native-stream.js` 编码，不依赖这个测试解码器。
