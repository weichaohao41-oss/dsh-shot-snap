# 上架插件市场：还差哪几步

包已经整理好、能装能跑（用 `npm pack` 出的 tarball 装过一遍，`/ping` 正常，v1.0.0）。
市场（`dshmarket` / 插件市场 / Awesome DSH Plugin）不是上传接口，而是**收 npm 包 + 收一个 YAML 条目**：

- 插件要能从 npm 装上（`dsh plugin add dsh-shot-snap`）；
- 条目要进 `awesome-dsh-plugin` 仓库的 `data/plugins/` 里（一个 PR 一个文件）。

这两步都需要**你自己的账号**（npm 登录态 + GitHub 仓库），我这边没有任何凭据，所以先把它整理到「你点头就能发」的状态。

## 1. 把包发到 npm（需要 `npm login`）

```powershell
cd C:\Users\Administrator\Desktop\新建文件夹\shot-snap-plugin
npm login          # 浏览器/终端里输入你自己的账号，密码别给我
npm publish        # package.json 已清掉 private，version 1.0.0，7 个文件 32.6 kB
```

发布后验证：

```powershell
npm view dsh-shot-snap version
```

## 2. 建 GitHub 仓库（条目和市场都要指向它）

```powershell
cd C:\Users\Administrator\Desktop\新建文件夹\shot-snap-plugin
git init -b main
git add .
git commit -m "feat: dsh-shot-snap 1.0.0 — screenshot into composer"
git remote add origin https://github.com/<你的账号>/dsh-shot-snap.git
git push -u origin main
```

别忘了给仓库加 **`dsh-plugin`** topic（仓库页右上 ⚙ → Topics）。
要求：仓库创建满 **1 天** 才能投条目（CI 会自动查）。

## 3. 投市场条目（一个 PR，一个文件）

1. fork https://github.com/awesome-dsh-plugin/awesome-dsh-plugin
2. 把本目录的 `market/OWNER__REPO.yml` 改名为 `data/plugins/<owner>__<repo>.yml`，
   并把里面 `OWNER/REPO` 换成真实仓库名；
3. 提交 PR（只加这一个文件，别动 README）。

合并后一天内，插件市场（`dshmarket`）和 `dsh-plugin-catalog` 索引就会收录，用户在「插件 → 发现」里能搜到、一键装。

## 我这边已经做完的事

- `package.json`：去掉 `private`，版本 1.0.0，双语 description、keywords（含 `dsh-plugin`）、`engines.dsh >= 0.2.0`、files 白名单、`dsh.bundle` + `dsh.client` 两侧 manifest；
- `LICENSE`（MIT）；
- `README.md`：安装命令、操作表、两种截图范围、快捷键改法、实现说明、隐私说明、FAQ、开发/卸载；
- 调试日志加了 256 KB 自动截断（README 里承诺的行为已真的实现），`node --check` 通过；
- 打包验证：`npm pack` → 32.6 kB / 7 个文件；用 `file:...tgz` 装进本机 profile，`/_dsh/shotsnap/ping` 返回 ok，host 半片正常，说明发布版安装路径通；
- 市场条目文件 `market/OWNER__REPO.yml`（category: `ui`，描述按「只说功能、不吹」的要求写，冒号已加引号）。

## 需要你做的（三选一）

1. **你给我 GitHub 仓库地址 + 已经 `npm login` 过**：我直接跑 `npm publish`、写 git 提交、把条目文件按正确文件名放到 fork 里（PR 需要浏览器点一下提交，或者给我 `gh` 的登录态）；
2. **只要我发 npm**：你先在这台机器上 `npm login`，告诉我，我来跑 publish 和后续校验；
3. **全部你自己操作**：照上面 1→2→3 走，我在这盯着报错帮你改。

## 备注

- 本机现在的安装源是 `file:...dsh-shot-snap-1.0.0.tgz`（跟发布版一样）；要继续改代码就先切回软链：
  ```powershell
  dsh plugin add link:C:\Users\Administrator\Desktop\新建文件夹\shot-snap-plugin
  ```
- 真要发之前记得把 `author` 换成你的名字/ID（现在写的是 `shot-snap contributors`）。
