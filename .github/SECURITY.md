# 安全策略

## 报告漏洞

**不要开公开 issue。** 请走 GitHub 的私密报告通道：

<https://github.com/ILoveHAKU/dsh-dialog-fence/security/advisories/new>

（仓库页 → Security → Report a vulnerability）

请附：DSH 版本、插件版本、复现步骤、影响面判断。收到后会尽快回。

## 这个插件的安全边界

dialog-fence 会把 `fence.json` 里的文本注入到**运行时上下文快照**，
也就是每一轮对话都会进入模型的上下文。因此：

- `fence.json` 及其自定义位置**等同于代码**：能被改写它的人，就能改写模型行为。
  不要把围栏文件放在共享盘、同步盘或任何可被他人写入的位置。
- 插件本身不做网络请求、不上传任何数据，规则只落在本地磁盘。
- 用 `--home` / 自定义路径安装时，注意别把围栏文件塞进会被 git 跟踪的目录
  （仓库 `.gitignore` 已经忽略 `fence.json`，但那只管本仓库）。

## 支持范围

只维护 `package.json` 里 `dsh.compatibility.dshReleases` 声明过的 DSH 版本。
其它版本上出现的问题，先升级再报。
