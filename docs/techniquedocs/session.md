这个文档我用来定义与设计 session
## 定义与目标
目前的 AI 产品基本分为 工作 与 chat 两类；session 就是对这些产品中基础实例，比如一个任务，或者一个 conversion 的抽象描述。起一个新的task，或者起一个新的聊天窗就意味着新起一个 session。session 需要管理一次任务或聊天运行过程中的所有状态与消息，记录并持久化所有历史事件与信息。session 可被 resume，这意味着持久化的内容在被重载后能构建起完整运行时快照。


## session 在内存中的模型
在一个 agent 进程中，为了防止 session 中对同一个文件区产生读写冲突，一个 agent 进程中只有一个活跃的 session。 session manger 需要能够 resume/change session，new session， delete session。 一定只能在 session idle 的时候操作。

SessionState {
    status: idle/ running/requires_action
    
}

SessionMetadata {
    id;
    title;
    projectDir; //属于哪个 project
    createdAt;
    lastModifiedAt;
    
    
}

Session {
    totalCost;
    modelUsage: {[model]: ModelUsage}
}

SessionMessages = AgentMessage[] 




## session 如何持久化
session 之间互不干扰

