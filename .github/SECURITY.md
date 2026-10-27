# 安全策略 / Security policy

## 报告漏洞 / Reporting a vulnerability

**不要开公开 issue。** 请走 GitHub 的私密报告通道：
**Do not open a public issue.** Use GitHub's private advisory channel:

<https://github.com/ILoveHAKU/dsh-dialog-fence/security/advisories/new>

（仓库页 → Security → Report a vulnerability / repo page → Security → Report a vulnerability）

请附：DSH 版本、插件版本、复现步骤、影响面判断。收到后会尽快回。
Please include the DSH version, the plugin version, reproduction steps, and your read of the blast
radius. You will get a reply as soon as possible.

## 这个插件的安全边界 / The security boundary of this plugin

dialog-fence 会把 `fence.json` 里的文本注入到**运行时上下文快照**，
也就是每一轮对话都会进入模型的上下文。因此：
dialog-fence injects the text in `fence.json` into the **runtime-context snapshot**, which means it
reaches the model's context on every turn. Therefore:

- `fence.json` 及其自定义位置**等同于代码**：能被改写它的人，就能改写模型行为。
  不要把围栏文件放在共享盘、同步盘或任何可被他人写入的位置。
  **`fence.json` and wherever you point it are equivalent to code**: whoever can rewrite it can rewrite
  the model's behavior. Do not put the fence file on a shared drive, a sync folder, or any location
  someone else can write to.
- 插件本身不做网络请求、不上传任何数据，规则只落在本地磁盘。
  The plugin makes no network requests and uploads nothing; rules only ever land on local disk.
- 用 `--home` / 自定义路径安装时，注意别把围栏文件塞进会被 git 跟踪的目录
  （仓库 `.gitignore` 已经忽略 `fence.json`，但那只管本仓库）。
  When installing with `--home` or a custom path, keep the fence file out of any directory tracked by
  git (this repo's `.gitignore` covers `fence.json`, but only for this repo).

## 支持范围 / Supported versions

只维护 `package.json` 里 `engines.dsh` 声明过的 DSH 版本。
其它版本上出现的问题，先升级再报。
Only DSH versions declared in `engines.dsh` in `package.json` are maintained.
For anything older, upgrade first and then report.

> 历史注记 / Historical note：0.12.1 之前这里写的是 `dsh.compatibility.dshReleases`，
> 那是一个全 asar 零命中的死字段；真正被读取的是 `engines.dsh`。
> Before 0.12.1 this section named `dsh.compatibility.dshReleases`, a dead field with zero hits
> across the whole asar. `engines.dsh` is the one DSH actually reads.
