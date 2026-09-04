; 文件关联钩子 —— 接管 Tauri 安装器漏掉的那一步。
;
; 为什么需要这个文件：
; Tauri 生成的 installer.nsi 会调用第三方宏 APP_ASSOCIATE 来写文件关联，
; 但那个宏内部用的符号 SHELL_CONTEXT 在整个脚本里从未被定义。
; NSIS 遇到未定义符号会当成普通字符串，于是所有注册表写入都指向一个名为
; "SHELL_CONTEXT" 的假根键 —— 静默失败，不报错，安装照样显示成功。
; 结果就是：装完双击 .md 毫无反应，而且完全看不出哪里出了问题。
;
; 验证方式（编译期探针，零副作用）：
;   !ifdef SHELL_CONTEXT / !else / !error "SHELL_CONTEXT is NOT DEFINED"
;
; Tauri 提供了 installerHooks 机制，允许把下面的宏挂进安装/卸载流程。
; 这里直接用 SHCTX 走 HKCU 分支 —— 需要管理员权限的话用户装一次软件
; 要弹两次 UAC，体验太差。
;
; 显式调用 SetShellVarContext current：虽然 Tauri 模板里没显式调用，
; 但保险起见自己钉一下，免得运行时上下文中途切换过。

!macro NSIS_HOOK_POSTINSTALL
  SetShellVarContext current
  DetailPrint "正在关联 .md / .markdown 文件"

  ; ---- 扩展名 → 文件类型 ---------------------------------------------------
  ; 先备份原来的关联，卸载时才能还原。
  ; 两个条件都要满足才写备份，否则重复安装会把备份覆盖成我们自己的类名，
  ; 卸载后就再也还原不回去了（实测踩过：备份被写成 MDReader.MarkdownDocument，
  ; 一卸载 .md 就指向一个不存在的类型，双击直接报错）。
  ;   ① 当前默认值已经是我们 → 说明早就关联过了，备份在第一次就存好了
  ;   ② 备份值非空 → 同理
  ; 注意 StrCmp 的跳转参数必须用标签。写成数字 0 会被 NSIS 当成标签名，
  ; 跳到一个不存在的地方，逻辑直接走反 —— 这里所有分支都用 Goto + 标签。
  ReadRegStr $R0 SHCTX "Software\Classes\.md" ""
  StrCmp $R0 "MDReader.MarkdownDocument" md_backup_done
  ReadRegStr $R1 SHCTX "Software\Classes\.md" "MDReader_backup"
  StrCmp $R1 "" md_do_backup md_backup_done
md_do_backup:
  WriteRegStr SHCTX "Software\Classes\.md" "MDReader_backup" "$R0"
md_backup_done:
  WriteRegStr SHCTX "Software\Classes\.md" "" "MDReader.MarkdownDocument"

  ReadRegStr $R0 SHCTX "Software\Classes\.markdown" ""
  StrCmp $R0 "MDReader.MarkdownDocument" markdown_backup_done
  ReadRegStr $R1 SHCTX "Software\Classes\.markdown" "MDReader_backup"
  StrCmp $R1 "" markdown_do_backup markdown_backup_done
markdown_do_backup:
  WriteRegStr SHCTX "Software\Classes\.markdown" "MDReader_backup" "$R0"
markdown_backup_done:
  WriteRegStr SHCTX "Software\Classes\.markdown" "" "MDReader.MarkdownDocument"

  ; ---- 文件类型的定义 ------------------------------------------------------
  ; 资源管理器「类型」列显示的文字。
  WriteRegStr SHCTX "Software\Classes\MDReader.MarkdownDocument" "" "Markdown 文档"
  ; 图标取主程序的第一个图标资源，不额外带一个 .ico，省得再维护一份。
  WriteRegStr SHCTX "Software\Classes\MDReader.MarkdownDocument\DefaultIcon" "" "$INSTDIR\${MAINBINARYNAME}.exe,0"

  ; ---- 双击时执行的命令 ----------------------------------------------------
  ; 路径必须加引号：默认装在 C:\Users\<名字>\AppData\Local\... 下，
  ; 用户名含空格时（很常见）不加引号会直接打不开。
  ; "%1" 同样要加引号，文件名带空格才不会在被打开时断成两截。
  WriteRegStr SHCTX "Software\Classes\MDReader.MarkdownDocument\shell" "" "open"
  WriteRegStr SHCTX "Software\Classes\MDReader.MarkdownDocument\shell\open" "" "用 MD 阅读器打开"
  WriteRegStr SHCTX "Software\Classes\MDReader.MarkdownDocument\shell\open\command" "" '$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\"'

  ; ---- 「打开方式」列表里也要出现 -----------------------------------------
  ; Windows 资源管理器右键 → 打开方式 → 选择其他应用 → 这个列表的来源是
  ; HKCU\...\FileExts\.md\OpenWithProgids 下挂着的 ProgID 列表。
  ; 写一个 REG_NONE 类型的空值即可，键名是 ProgID，值数据是空。
  ; 没有这一步，文件关联虽然生效（双击能开），但「打开方式」菜单里看不到，
  ; 用户切换默认应用时找不到我们。
  WriteRegNone SHCTX "Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.md\OpenWithProgids" "MDReader.MarkdownDocument"
  WriteRegNone SHCTX "Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.markdown\OpenWithProgids" "MDReader.MarkdownDocument"

  ; ---- 通知资源管理器刷新 --------------------------------------------------
  ; 不调这一下，图标和「打开方式」列表要等 explorer 重启才更新，
  ; 用户会以为没装成功。0x08000000 = SHCNE_ASSOCCHANGED，0x1000 = SHCNF_FLUSH。
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0x1000, i 0, i 0)'
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  SetShellVarContext current
  DetailPrint "正在解除 .md / .markdown 文件关联"

  ; 还原扩展名指向：把安装时备份的值写回去。
  ; 备份为空说明这个扩展名原本没有关联，那就把默认值删掉 ——
  ; 留一个空字符串在那里会让双击变成「选择打开方式」的弹窗，比没有更糟。
  ReadRegStr $R0 SHCTX "Software\Classes\.md" "MDReader_backup"
  ; 备份值等于我们自己的类名，说明它是坏掉的旧版本写进去的。
  ; 按「没有备份」处理，正好把这台机器的坏状态自愈掉，
  ; 免得卸载之后 .md 指向一个不存在的类型。
  StrCmp $R0 "MDReader.MarkdownDocument" md_no_backup
  StrCmp $R0 "" md_no_backup md_restore
md_no_backup:
  DeleteRegValue SHCTX "Software\Classes\.md" ""
  Goto md_done
md_restore:
  WriteRegStr SHCTX "Software\Classes\.md" "" "$R0"
md_done:
  DeleteRegValue SHCTX "Software\Classes\.md" "MDReader_backup"

  ReadRegStr $R0 SHCTX "Software\Classes\.markdown" "MDReader_backup"
  StrCmp $R0 "MDReader.MarkdownDocument" markdown_no_backup
  StrCmp $R0 "" markdown_no_backup markdown_restore
markdown_no_backup:
  DeleteRegValue SHCTX "Software\Classes\.markdown" ""
  Goto markdown_done
markdown_restore:
  WriteRegStr SHCTX "Software\Classes\.markdown" "" "$R0"
markdown_done:
  DeleteRegValue SHCTX "Software\Classes\.markdown" "MDReader_backup"

  ; 清掉我们自己建的文件类型。
  DeleteRegKey SHCTX "Software\Classes\MDReader.MarkdownDocument"

  ; 清掉「打开方式」列表里的登记。
  DeleteRegValue SHCTX "Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.md\OpenWithProgids" "MDReader.MarkdownDocument"
  DeleteRegValue SHCTX "Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.markdown\OpenWithProgids" "MDReader.MarkdownDocument"

  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0x1000, i 0, i 0)'
!macroend