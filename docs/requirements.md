# 基于pi的环境管理软件
## 实现的目的
在pi coding agent的基础上提供一个环境管理软件，每个agent包含独立的system prompt、工具集、skill、MCP server、extension、运行时策略、 记忆、快捷键、主题
在pi的基础上提供数据捕捉软件，通过强化学习提升skills的可用性和稳定性
提供回测技术和数据分析功能，帮助用户优化环境管理策略
## 功能模块
一是提供一个默认的环境管理cli命令
```bash
ponda env
```
用户可以手动创建、删除、切换环境，也可以通过配置文件自动创建和切换环境
```
ponda env create <env_name>  # 创建新环境
ponda env rm <env_name>  # 删除环境
ponda env activate <env_name>  # 切换环境
```
环境可以在不同基础配置上继承
```
ponda env create <env_name> --base <base_env_name>  # 创建新环境并继承基础环境配置
```
提供默认的pi coding agent配置文件，用户可以在此基础上进行自定义配置
```
# 默认配置文件示例
system_prompt: "You are a helpful coding agent."
tools:
    - name: "Tool1"
        description: "Description of Tool1"
        command: "command_for_tool1"
    - name: "Tool2"
        description: "Description of Tool2"
        command: "command_for_tool2"
skills:
    - name: "Skill1"
        description: "Description of Skill1"
    - name: "Skill2"
        description: "Description of Skill2"
prompt: "Default prompt for the agent."
privileges:
    - "read"
    - "write"
    - "execute"
```
提供bash/zsh/fish等shell的快捷键配置，用户可以通过快捷键快速切换环境和执行常用命令
```
(pi:default) ponda env activate <env_name>  # 切换环境
(pi:default) ponda env create <env_name>  # 创建新环境
(pi:default) ponda env rm <env_name>  # 删除环境
(pi:default) ponda env list  # 列出所有环境
(pi:default) ponda env info <env_name>  # 查看环境信息
```
default是对应的环境名称，切换环境的时候会自动更新shell提示符，显示当前环境名称
在pi coding agent的基础上提供沙箱隔离机制，确保agent不会直接访问系统资源，所有的系统调用和文件操作都在沙箱中进行，保证环境的安全性和稳定性
沙箱机制通过如果是针对单一文件或多个文件进行修改不是在文件夹（工作区）下进行操作的话，系统会自动创建一个临时工作区，并在其中进行操作，agent创建临时工作区，并拷贝文件，确保原文件不会被自动删除
如果是在文件夹（工作区）内进行操作，系统会在工作区目录检查是否有一个git配置文件，如果没有则自动创建一个git配置文件，确保所有的修改都可以被追踪和回滚
隔离机制通过worktree和git配置文件实现，worktree是一个独立的工作区，git配置文件用于记录工作区的状态和修改历史
用户确认之后，agent会将修改提交到git配置文件中，并生成一个新的commit，用户可以通过git log查看修改历史，也可以通过git checkout回滚到之前的版本
合并操作需要提示用户手动进行确认

ponda切换环境后，pi会自动根据当前环境配置，连接到不同的执行文件目录
每个pi的skills等配置文件都是存在独立的一个目录，通过软连接到当前环境的执行文件目录，确保每个环境的配置和执行文件都是独立的，互不干扰


ponda 提供 skills等配置文件的管理工作
```
ponda skills list  # 列出所有skills
ponda skills add <skill_name>  # 添加新skill
ponda skills rm <skill_name>  # 删除skill
ponda skills update <skill_name>  # 更新skill
ponda skills info <skill_name>  # 查看skill信息
```
也提供cli工具管理功能
```
ponda tools list  # 列出所有工具
ponda tools add <tool_name>  # 添加新工具
ponda tools rm <tool_name>  # 删除工具
ponda tools update <tool_name>  # 更新工具
ponda tools info <tool_name>  # 查看工具信息
```
提供provider和model的管理功能，因为provider和model都是复杂配置，提供交互式的配置方式，用户可以通过命令行交互式的配置provider和model
```
ponda provider list  # 列出所有provider
ponda provider add <provider_name>  # 添加新provider
ponda provider rm <provider_name>  # 删除provider
ponda provider update <provider_name>  # 更新provider
ponda provider info <provider_name>  # 查看provider信息
ponda model list  # 列出所有model
ponda model add <model_name>  # 添加新model
ponda model rm <model_name>  # 删除model
ponda model update <model_name>  # 更新model
ponda model info <model_name>  # 查看model信息
```
提供prompt的管理功能，用户可以通过命令行交互式的配置prompt
```
ponda prompt list  # 列出所有prompt
ponda prompt add <prompt_name>  # 添加新prompt
ponda prompt rm <prompt_name>  # 删除prompt
ponda prompt update <prompt_name>  # 更新prompt
ponda prompt info <prompt_name>  # 查看prompt信息
```
提供memory的管理功能，用户可以通过命令行交互式的配置memory
```
ponda memory reset  # 重置memory
```
ponda提供extension的管理功能，用户可以通过命令行交互式的配置extension
```
ponda extension list  # 列出所有extension
ponda extension add <extension_name>  # 添加新extension
ponda extension rm <extension_name>  # 删除extension
ponda extension update <extension_name>  # 更新extension
ponda extension info <extension_name>  # 查看extension信息
```
提供主题的管理功能，用户可以通过命令行交互式的配置主题
```
ponda theme list  # 列出所有主题
ponda theme add <theme_name>  # 添加新主题
ponda theme rm <theme_name>  # 删除主题
ponda theme update <theme_name>  # 更新主题
ponda theme info <theme_name>  # 查看主题信息
```
提供history的管理功能，用户可以通过命令行交互式的配置history
```
ponda history list  # 列出所有history
ponda history attach <history_name>  # 继续该history的会话
ponda history rm <history_name>  # 删除history
ponda history info <history_name>  # 查看history信息
ponda history search <keyword>  # 搜索history
```
以上是ponda提供的所有的命令的功能

在以上ponda功能的基础上，提供一个不用切换环境就可以使用不同的agent的功能，用户可以通过命令行交互式的配置agent
```
ponda <env name> skill list # 列出当前agent的所有skills
```
等快速操作
## 基于pi的扩展
### tui交互页面扩展
在pi coding 基础上提供一个tui交互界面
输入
```
ponda tui
```
可以进入tui 对话页面
左边栏包含当前agent的历史会话信息：
    按照工作区分不同工作区的历史会话信息，上下文窗口消耗的token量等
下方是当前agent和所有agent已经消耗的token量和费用
左边栏目也支持从会话信息切换到文件列表
    点击文件夹可以进行逐级展开
    点击文件后在主体部分进行展开

中间是对话主体页面：
    对话主体支持markdown格式在终端的渲染，支持代码块的高亮显示，支持图片的显示，支持表格的显示，支持数学公式的显示
    支持思考折叠
    子步骤折叠特性

    下方是对话窗口，支持输入对话信息，支持@引用文件的功能，支持/命令功能，显示当前所选的模型、思考强度，当前上下文窗口大小、当前模式，计划模式、批准模式、全自动模式的切换
    
    对话窗口上方显示当前活跃的子agent，用户可以切换到不同的agent，对不同的子agent进行对话操作

    对话窗口的markdown支持文件超链接，点击超链接后在主体部分显示内容，点击不同的标签页可以实现切换

右边栏目显示的当前todolist
当前一个长时任务，被切分成多个子任务后，显示每个子任务的进度，显示不同子任务的完成状态

### 对话过程中，支持任务权限的申请
通过弹出选择框给用户进行快速选择

## 扩展功能
### todolist 扩展
这是pi agent能够将一个长时任务切分成多个子任务，并且能够对每个子任务进行独立的管理和跟踪
### 支持goal模式
goal模式是指用户可以给agent设置一个目标，agent会根据目标进行任务分解和任务执行，用户可以通过命令行交互式的配置goal模式
### 支持后台对话存活机制
当用户输入完要求后，切换到不同会话的时候，任务执行不会中断，会在后台持续执行
### 支持状态描述和确认
当输入一个长时任务的时候，第一步不仅是做计划和任务拆分
更需要生成一个任务计划产出清单，和每个成果的状态描述，交给用户进行确认
确认后生成状态自动确认校准代码
当任务快要结束的时候要比对成果状态
执行过程中如果需要切换状态的话，需要提前申请用户同意
状态在执行过程中，会一直展示在右边栏中，给用户时刻提醒
### 支持上下文压缩
长时任务使用skill.state模式[./2608.26263v3.pdf]进行上下文管理参照
### 支持agent swarm功能
agent swarm是指多个agent协同工作，完成一个复杂的任务
agent在执行过程中可以根据任务，构建起多个子agent，子agent之间可以进行通信和协作，完成任务的不同部分
### 支持按照项目生成wiki知识库
在工作区区间，agent可以自动构建wiki知识库，用来加速文件检索和知识管理，目录存放在.wiki目录下

