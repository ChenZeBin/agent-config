# 计划类型与能力边界

核验日期：2026-09-27。执行外部写入前，若 Apple 文档或本机 `asc` 命令面已变化，应重新核对。

## Apple Developer Program：组织

- 使用 App Store Connect API 和 `asc`。
- `userInvitations` 创建团队邀请；收件人接受后才出现在 `users`。
- 组织成员可获得 Developer Program 团队资源，但实际能力仍受角色和 Certificates, Identifiers & Profiles 权限控制。
- 用于设备 Provisioning 的调用应使用 Team API key；Individual API key 不能使用 Provisioning endpoints。

官方入口：

- [App Store Connect API](https://developer.apple.com/help/app-store-connect/get-started/app-store-connect-api)
- [User Invitations](https://developer.apple.com/documentation/appstoreconnectapi/user-invitations)
- [Devices](https://developer.apple.com/documentation/appstoreconnectapi/devices)
- [Creating API Keys](https://developer.apple.com/documentation/appstoreconnectapi/creating-api-keys-for-app-store-connect-api)

## Apple Developer Program：个人

- 可邀请额外用户访问 App Store Connect，但被邀请者不属于 Developer Program 团队，也没有 Certificates, Identifiers & Profiles 等其他会员资源。
- 不要把个人账号下的 App Store Connect 邀请描述为“开发者团队账号创建”。设备注册由 Account Holder 的凭据集中执行。

官方入口：[Add and edit users](https://developer.apple.com/help/app-store-connect/manage-your-team/add-and-edit-users)

## Apple Developer Enterprise Program

- Enterprise 不使用 App Store Connect API；使用独立的 Enterprise Program API。
- API 基础域名是 `https://api.enterprise.developer.apple.com`，有独立的 API access、角色和 key。
- 本 Skill 当前不执行 Enterprise 写入。本机 `asc users`、`asc devices` 面向 App Store Connect；不得更换域名猜测调用，也不得复用 App Store Connect 凭据试探。
- 需要 Enterprise 自动化时，先建立独立 Skill 或经授权的客户端，覆盖 Enterprise JWT、`userInvitations`、`users`、`devices`、确认与写后核验。

官方入口：

- [Enterprise Program API](https://developer.apple.com/documentation/enterpriseprogramapi)
- [Enterprise User Invitations](https://developer.apple.com/documentation/enterpriseprogramapi/user-invitations)
- [Enterprise Devices](https://developer.apple.com/documentation/enterpriseprogramapi/devices)

## 不是同一类账号

- `userInvitations` 发送团队邀请，不会直接创建 Apple Account。收件人必须关联已有 Apple Account，或在激活流程中自行创建。
- Managed Apple Account 属于 Apple Business Manager / Apple School Manager 的组织身份体系，不由 App Store Connect 成员邀请代替。
- TestFlight 内部/外部测试者、Sandbox tester 和开发团队成员是不同资源；按真实目标使用对应 `asc testflight` 或 `asc sandbox` 流程。

## 设备配额

- Apple Developer Program 和 Enterprise Program 按产品系列、每个会员年度限制测试设备数量；当前官方说明为每类最多 100 台。
- 禁用设备不会返还当年额度；API 不能把“禁用”当作删除或额度恢复。
- 新会员年度的设备列表重置由 Apple Developer 网站流程处理。

官方入口：[Devices overview](https://developer.apple.com/help/account/devices/devices-overview)
