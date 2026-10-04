# 配色交付装配与终检细则

配色装配失败时，使用下面的通用回执函数保留实际检查正文及字数。它调用现有 assembleColorDelivery 与原 checkColorDelivery，不更改两者，也不替换任何来源事实或验收。source_separator 默认是单个实际换行 "\n"；纯空白的双换行、CRLF 或空格不受现有装配器支持。需要段间空行时，把空行放进 body 字符串，或使用非空白分隔符。不要把字面量反斜杠 n 当换行。

```javascript
function inspectColorAssembly(data, assembler, originalCheck) {
  let actual = null;
  try {
    const draft = assembler(data, input => {
      actual = input;
      return originalCheck(input);
    });
    if (!actual || draft !== actual.draft) throw new Error("same checked body required");
    return {kind: "typeless_checked_delivery", draft,
      characters: [...draft].length, max_chars: actual.max_chars ?? null,
      original_checker_reached: true};
  } catch (error) {
    const draft = typeof actual?.draft === "string" ? actual.draft : null;
    return {kind: "typeless_failed_delivery", error: String(error.message ?? error),
      draft, characters: draft === null ? null : [...draft].length,
      max_chars: data?.max_chars ?? null, original_checker_reached: actual !== null};
  }
}
```

首次正常完整读取并存储主 Skill 后，回看及函数提取都复用该内存正文；不要再对同一源路径做分段 sed、head、tail 或 wc。完整返回没有截断就无需重新确认尾段。缺少缓存或首次实际返回截断时才重新取得完整来源，不能把分段摘录声称为全文。下面的提取只建立三个已有函数的绑定，不执行 Markdown，也不重写检查器。data 必须是当前任务实填的唯一数据对象。

```javascript
const source = load("typeless_full_skill");
if (typeof source !== "string") throw new Error("complete cached Skill required");
const onlyFunction = name => {
  const blocks = source.match(new RegExp("function " + name + "\\([^\\n]*\\) \\{[\\s\\S]*?\\n\\}", "g"));
  if (blocks?.length !== 1) throw new Error("unique original function required: " + name);
  return blocks[0];
};
const inspect = new Function(
  ["inspectColorAssembly", "assembleColorDelivery", "checkColorDelivery"].map(onlyFunction).join("\n") +
  "\nreturn data => inspectColorAssembly(data, assembleColorDelivery, checkColorDelivery);"
)();
const receipt = inspect(data);
text(receipt);
```

typeless_failed_delivery 不能外发为已检查终稿。若原检查器尚未到达，正文与字数明确为 null，不虚构零字数；若已到达，按回执中的实际全文与字符数修正同一份 data 后重查。超长时压缩重复论述，保留原请求要求的来源、条数、命名组件与完整历史分类。观察 component 逐字使用已读记录的命名条目；fact 只放其具体所见事实。历史 label 使用任务给出的完整原分类，后续决定和未来条件都用该 label 回指。只有成功回执的 draft 可直接作为 final；不额外添加 Markdown 两空格、标题、围栏、解释或重排段落。结构回执仍不证明事实正确、品牌授权存在或独立验收通过。

配色正文可先用下面的通用装配函数，从一份真实数据生成允许格式内的五项来源和最终正文，再调用原 checkColorDelivery。它不提供颜色、组件方案、品牌判断或来源事实。所有字段、原观察版本与组件、历史分类、决定和字数限制仍由当前任务及已读材料实填。sources 只填写原始请求、当前源码颜色、已确认品牌、本次转译建议；参考观察从 observations 的 source/version/component/fact 自动组成，不重复手写两份引用。histories 的 label 保留完整原分类；registration_field 指向原允许来源字段；正文引用使用 {history: 下标, text: 实际依据或决定}，由同一 label 装配完整回指。不能将未知值填写为不存在，不能把指南规则放入 fact。

body 按原输出格式依次放字符串和唯一一个 {sources: true} 标记。该标记位于首个允许条目、来源判断或 token 代码块内部注释；字符串原样保留空行、围栏、CSS 与标点，不在装配后重写。source_separator 可用换行或分号，不能是空串。观察版本、实际组件和完整角色不能为缩短字数而改写。若强调色角色适用，accent_scope 必须包含完整的焦点、当前状态与关键动作，且实际正文仍须包含传入的原限制。失败时只修正该份数据或格式；不反复 wc 已完整收到的材料，不以行数或尾部代替实际全文。

```javascript
function assembleColorDelivery(data, originalCheck) {
  const requireValue = (ok, message) => { if (!ok) throw new Error(message); };
  const nonempty = value => typeof value === "string" && value.trim().length > 0;
  requireValue(data && typeof data === "object" && typeof originalCheck === "function", "assembly inputs required");
  const names = ["原始请求", "当前源码颜色", "参考观察", "已确认品牌", "本次转译建议"];
  const fields = {};
  for (const name of names.filter(name => name !== "参考观察")) {
    requireValue(data.sources && nonempty(data.sources[name]), "missing real source data: " + name);
    fields[name] = data.sources[name];
  }
  requireValue(Array.isArray(data.observations), "observation data required");
  const observations = data.observations.map(observation => {
    for (const key of ["source", "version", "component", "fact"])
      requireValue(nonempty(observation[key]), "missing actual observation " + key);
    return {...observation};
  });
  if (observations.length) {
    fields["参考观察"] = observations.map(observation => [observation.source, observation.version, observation.component, observation.fact].join("｜")).join("；");
  } else {
    requireValue(nonempty(data.observation_gap), "actual observation gap required");
    fields["参考观察"] = data.observation_gap;
  }
  requireValue(Array.isArray(data.histories), "history data required");
  const histories = data.histories.map(history => {
    requireValue(nonempty(history.label) && nonempty(history.value), "complete original history required");
    requireValue(["原始请求", "当前源码颜色"].includes(history.registration_field), "history registration must use allowed source field");
    fields[history.registration_field] += "；" + history.label + "：" + history.value;
    return {label: history.label, value: history.value, references: []};
  });
  const separator = data.source_separator ?? "\n";
  requireValue(nonempty(separator) || separator === "\n", "source boundary separator required");
  const sourceBlock = names.map(name => name + "｜" + fields[name]).join(separator);
  requireValue(Array.isArray(data.body) && data.body.length, "actual output parts required");
  let sourceMarkers = 0;
  const draft = data.body.map(part => {
    if (typeof part === "string") return part;
    requireValue(part && typeof part === "object", "invalid output part");
    if (part.sources === true && Object.keys(part).length === 1) {
      sourceMarkers++;
      return sourceBlock;
    }
    requireValue(Number.isInteger(part.history) && part.history >= 0 && part.history < histories.length && nonempty(part.text), "actual historical reference required");
    const history = histories[part.history];
    const reference = history.label + "｜" + part.text;
    history.references.push(reference);
    return reference;
  }).join("");
  requireValue(sourceMarkers === 1, "exactly one source block required");
  if (data.accent_scope != null) {
    requireValue(nonempty(data.accent_scope) && ["焦点", "当前状态", "关键动作"].every(role => data.accent_scope.includes(role)), "original accent roles must remain complete");
  }
  const checked = originalCheck({draft, observations, observation_gap: data.observation_gap, histories, accent_scope: data.accent_scope, max_chars: data.max_chars});
  requireValue(checked === draft, "original checker must return the same complete body");
  return checked;
}
```

已完整存储主 Skill 后，从同一正文各提取唯一的 assembleColorDelivery 和原 checkColorDelivery 函数，在内存执行，不重新拼源路径。只为函数命名建立绑定；不要执行整份 Markdown，不改原函数。传入本次真实 data 后，以 text({kind: "typeless_checked_delivery", draft: assembleColorDelivery(data, checkColorDelivery)}) 返回完整正文，并把该实际返回直接作为 final。结构检查仍不证明观察事实正确、记录已经存在或独立验收通过。

首次完整读取主 Skill 时，在照常完整 text(r.output) 的同一 functions.exec 中，另将该完整返回 store("typeless_full_skill", r.output)。完整返回仍必须送达，不以存储替代读取。终稿检查可从这份已读正文提取原 checkColorDelivery 函数，在内存中执行同一个函数，避免重写函数或重复读源；不要执行整份 Markdown。若实际运行不支持 load/store/Function，就在当前内存中原样使用下方原函数，仍只维护一份正文。

```javascript
const fullSkill = load("typeless_full_skill");
if (typeof fullSkill !== "string") throw new Error("complete Skill body not stored");
const originalFunctions = fullSkill.match(/function checkColorDelivery\(p\) \{[\s\S]*?\n\}/g);
if (!originalFunctions || originalFunctions.length !== 1) throw new Error("original checker function is not uniquely bound");
const checkColorDelivery = Function("return (" + originalFunctions[0] + ")")();
// p 使用本次真实数据，draft 已包含全部空行、引用标记、代码围栏和标点。
try {
  const checkedDraft = checkColorDelivery(p);
  if (typeof checkedDraft !== "string" || checkedDraft !== p.draft) throw new Error("checker did not return exact draft");
  text({kind: "typeless_checked_delivery", draft: checkedDraft});
} catch (e) {
  text({kind: "typeless_delivery_check_failed", error: String(e.message), characters: [...p.draft].length, max_chars: p.max_chars ?? null});
}
```

先把最终空行、反引号引用和围栏直接写入 draft，再检查并原样发送。成功后不美化 Markdown、不替换引用格式、不补开场状态，也不重组相同含义的另一正文；若确需任何修改，修改同一个 draft 后再检查。回执中的 draft 必须是完整正文字符串，不能用 Python 检查摘要冒充正文。结构成功不等于来源事实或独立验收通过。

所有会决定颜色的组件方案与短评，在第一个允许条目实填五个完整字段名。参考事实保留实际 observations 文件名、原版本、原组件和具体事实。原请求的“当前状态”“关键动作”等角色逐字保持；不能为了字数换成更宽的“状态”“动作”。历史来源名称先取完整原分类，否定、依据和未来条件都复制此名称；不要另用“该色”“旧绿”“该旧版示例绿色”来指代。当前用户的新决定独立记录。

终稿只维护一份正文。把本次真实数据直接写成 JSON 对象，draft 属性使用正确转义的双引号字符串；普通正文不是 JSON 编码，不要对它调用 JSON.parse。CSS 引号与 Markdown 围栏都属于这份正文，检查前后不另包或重写。完整主 Skill 已读后，独立的观察和指南可在一次 functions.exec 中分别发起两个 exec_command，分别完整 text(r.output)；材料命令仍用当前包内的完整绝对路径，每个内外预算充足。

交付中的内部材料引用使用实际文件名、实际版本、原组件和具体事实，足以定位所读记录；不暴露临时执行目录或随机采集目录。用户需要打开实际源码或产物时，才提供对应真实文件链接。材料正文中的版本、组件与状态逐字核对，不凭记忆改写版本。观察未覆盖的行为直接标明“未验证”或“未实测”，并另写目标建议；不能让“尚未确认”掩盖测试状态。

紧字数正文先留至少两成余量，减少重复叙述，保留五来源、文件与组件事实、原角色限制和完整历史分类。终检失败时返回实际字符数、上限与具体错误，直接修正同一正文；不要在不知道当前长度时反复小幅改字。结构检查成功后，原样交付其返回的正文，不先发进度再组织另一版终稿。历史项的每个否定、依据和条件句都复用其完整原分类名，新用户决定单列且不能写成已发生。

已有通用检查函数代入本次真实 p 后，可这样返回结果；p 不得留占位内容。成功回执只证明结构核对，来源事实与独立语义审查仍须完成。

```javascript
const characters = [...p.draft].length;
try {
  text({kind: "typeless_checked_delivery", draft: checkColorDelivery(p)});
} catch (e) {
  text({kind: "typeless_delivery_check_failed", error: String(e.message), characters, max_chars: p.max_chars ?? null});
}
```

必要控件边界按每个可操作状态核验，包含 hover 和 pressed；不能把默认态可辨的边界在悬停时换成装饰分隔线。承担识别作用的边界保持实际相邻背景至少 3:1，普通文字至少 4.5:1。装饰性 border-subtle／border-strong 不自动成为控制边界，命名不等于对比度证明。

先在内部填完原始请求、当前源码颜色、参考观察、已确认品牌、本次转译建议，再按用户允许格式交付。开场只给结论，不复述历史色号；确需引用历史值，首次用“完整原来源分类＋值”这一不可拆单位登记，后续用相同完整分类名回指，开场、否定、纠正、未来例子也遵守。不要因同值当前提案或假设将来用户采用而改写原历史分类；新的真实用户决定另记。参考观察必须有实际所见事实：“已读文件／版本 → 原页面或组件 → 具体所见颜色、结构或行为”；仅写文件名、组件名或状态名仍是空记录。每项事实只从已读材料中摘取，指南规则留在本次建议。来源、结论、字数与条数均收在允许范围内，短答保留原角色限制并留字数余量，发送前实际核对长度。

读取时每个文件分别完整读取；不要把多个长文件合进一个返回。使用 functions.exec 时，在首行设置实际外层 max_output_tokens，内层预算不替代外层。每次核对返回末尾与截断提示；已完整收到的文件不重读，仅为具体缺字补读受影响文件。读取成功不等于设计或验收完成。

发出配色终稿前，实际做一次全文检查并把更正合进正文：①在用户允许的第一个条目或代码注释中实填原始请求、当前源码颜色、参考观察、已确认品牌、本次转译建议；一句短评也须容纳五项，未知项用准确短语记录，删去过程说明和重复解释来腾空间。②从本次上下文列出历史颜色，全文逐个查找；仅在来源登记项保留一次“完整原来源分类＋值”，开场、否定、决定和未来条件均改为同一完整分类名回指；不得改成“该色／当前该色”或另归当前提案。③参考观察逐句对照已读观察记录的原组件名和实际观察列；保持名称、表面对象与事实一一对应，不把侧栏变为分组表面，不将指南转译列当成观察。④核对默认判定对象、原请求的角色限制、条数与实际长度；超限时缩短重复文字，五项字段和事实分类保留。当前用户明确指定或保留的决定按原范围执行，不为此新增确认。

涉及默认视觉方向的判断或替代方案，只要要决定背景、描边、按钮或反馈颜色，也属于配色交付；即使没有色号、只许短答，五项来源仍在允许格式内实填。纯非配色任务保持原边界。

组装终稿时先锁定每项历史颜色的完整原来源分类。把这个原分类当作不可缩短的名称；所有引用它的依据、结论、纠正和未来条件都直接复用同一名称，不能只在来源表出现。当前团队提案或后来真实用户决定另列，不替换原历史记录。发送前用一次真实只读工具调用检查完整终稿；不要仅口头声称检查。可使用下面的通用函数，在内存中代入本次真实草稿、完整历史分类、实际涉及历史项的依据／结论片段及原请求字数上限后执行。必须把开场判定和无标题的引用段也纳入片段；“该色／当前颜色／团队所提颜色”均算引用。调用中不得留占位文字，不写产品文件；检查失败则实际修正文稿并再查，通过的结构检查仍不替代逐句来源事实和独立语义核验。

```python
def check_color_delivery(draft, historical_classes, reference_blocks, max_chars=None):
    assert isinstance(draft, str) and draft.strip()
    fields = ("原始请求", "当前源码颜色", "参考观察", "已确认品牌", "本次转译建议")
    assert all(field in draft for field in fields), "missing source field"
    assert all(isinstance(label, str) and label.strip() for label in historical_classes)
    if historical_classes:
        assert reference_blocks, "historical reasoning/decision not checked"
    for block in reference_blocks:
        assert isinstance(block, str) and block and block in draft, "not an actual final fragment"
        assert all(label in block for label in historical_classes), "historical classification shortened"
    if max_chars is not None:
        assert isinstance(max_chars, int) and max_chars > 0
        assert len(draft) <= max_chars, "original output length exceeded"
    return {"characters": len(draft), "source_fields": len(fields), "checked_reference_blocks": len(reference_blocks)}
```

仅检查字段和分类字面还不够：对照已读原组件的实际观察列核对事实对象，所有指南规则放本次建议；保留原角色限制、条数和用户明确指定／保留的决定。没有要求数值报告时不额外外发比值。最终只输出原请求允许的真实交付内容，不外发这段检查代码、工具回执或检查过程。

终稿检查采用一次完整草稿，不要先写一版检查稿再另行组织终稿。优先直接在 functions.exec 的 JavaScript 内存中执行下面的通用检查，避免为检查正文拼接 shell、Node 命令或反复处理引号。只代入真实终稿和已读取材料中的实际来源、组件、事实及历史分类；不要再生成第二份草稿。全部历史回指段逐段传入，连“该值”的短句也须改成完整历史名称；观察单元必须包含文件、组件和实际事实。短答也保留这些定位，“当前状态”不能缩成任意状态。检查通过后直接外发工具返回的同一正文；修改任何字句后先重查。未要求数值时不另加检查比值。旧 Python 检查仍可用，但同样必须绑定最终正文并逐句查来源。结构通过不能代替来源事实与独立语义审查。

```javascript
function checkColorDelivery(p) {
  const ensure = (condition, message) => { if (!condition) throw new Error(message); };
  const d = p.draft;
  ensure(typeof d === "string" && d.trim(), "empty delivery");
  for (const field of ["原始请求", "当前源码颜色", "参考观察", "已确认品牌", "本次转译建议"])
    ensure(d.includes(field), "missing source field: " + field);
  ensure(Array.isArray(p.observations), "observation records required");
  if (!p.observations.length) ensure(typeof p.observation_gap === "string" && p.observation_gap && d.includes(p.observation_gap), "missing real observation gap");
  for (const o of p.observations)
    for (const key of ["source", "component", "fact"])
      ensure(typeof o[key] === "string" && o[key].trim() && d.includes(o[key]), "missing observation " + key);
  ensure(Array.isArray(p.histories), "history records required");
  for (const h of p.histories) {
    ensure(typeof h.value === "string" && h.value && typeof h.label === "string" && h.label && d.includes(h.label), "missing original history");
    ensure(d.split(h.value).length === 2, "historical value must be registered once");
    ensure(Array.isArray(h.references) && h.references.length, "historical references required");
    for (const block of h.references)
      ensure(typeof block === "string" && block && d.includes(block) && block.includes(h.label), "historical reference shortened");
  }
  if (p.accent_scope) ensure(d.includes(p.accent_scope), "original accent role restriction missing");
  if (p.max_chars != null) ensure(Number.isInteger(p.max_chars) && p.max_chars > 0 && [...d].length <= p.max_chars, "original character limit exceeded");
  return d;
}
// 另用本次实际数据构造 p 后调用；不要在最终交付展示检查代码。
text({kind: "typeless_checked_delivery", draft: checkColorDelivery(p)});
```

已读主 Skill 后，互相独立的观察和指南读取可用 Promise.all 在同一调用内并行；每个原始文件仍分别完整返回，保留足够的内外输出预算，不能摘要或隐藏原文。不改用户允许的输出形式，不以评测预算为由少读材料。

实际检查正文时，把完整终稿放在合法 JSON 数据字符串中，使用双引号和正确的 JSON 转义；不要用 JavaScript 反引号模板字符串承载 Markdown 围栏，也不要为了拼命令反复重写正文。代码围栏中的反引号会提前结束模板字符串，不能以“只查无围栏正文，随后再包围栏”宣称检查了同一终稿。优先直接调用上面的内存检查函数；工具只返回原样正文，不再追加检查过程。任何解析失败先修正数据字符串格式，不改设计事实，不用空草稿绕过检查。

紧字数时先删去重复叙述与流程说明。原始请求只记会影响配色的真实约束，不必重述整句原话；已在用户上文完整列出的整组提案，可明确指代该整组来作判定，不必再次枚举。腾出的篇幅保留观察文件、实际组件和具体事实、五项来源及原角色限制。未提供不能写成已确认不存在，观察名称不能因压缩而移到另一个组件；历史类别保持完整，不靠省略类别省字数。

把 Typeless 的视觉原则转成适合目标产品的设计决策，而不是复刻 Typeless。

配色终稿采用事实与规则分开的装配顺序：先实填五项来源，再写开场结论和决定。参考观察只从已读 observations-2.8.0.md 的“实际观察”内容摘取，并沿用该事实对应的页面／组件条目名称及状态；不要把观察表的“可复用转译”列一并复制。用“文件／版本 → 原条目名称 → 具体状态事实”记录每条事实，不把不同组件合为无名称的焦点、添加或错误。所有 style-system.md 的规则、默认、token 和解释句都直接放进本次转译建议，参考观察字段写完即结束；不得在该字段的尾句追加“指南规定／指南建议”，即使准确称为建议也须移走。完整历史分类先登记再出现色值，开场、请求否定句和未来条件均不得先裸列历史值。只允许 token 和按钮决定时，五项来源写在表格前的简短 HTML 注释、CSS 代码块内部注释或对应按钮决定的注释中，不另列来源段落。短答和固定条数只在原允许条目中选最短的相关真实事实，不省类别、不增加条目。发送前逐字段核对这些来源边界；发现错栏则在主要正文中实际移位后再发送。

适用的配色终稿先写五项来源，再写决定。最终输出的首个允许条目、注释或来源判断内，明确保留这五个字段名：原始请求｜当前源码颜色｜参考观察｜已确认品牌｜本次转译建议；逐项填入真实事实、未读或未确认状态。固定条数方案把五项合进第一条，不能省略，也不能增加第六种来源。原始请求只复述实际要求；“未要求／没有提供”不等于“明确拒绝／明确不要求”。没有点名某历史色时，不为否认它而在请求项引入裸历史值；先在当前源码或独立历史来源项登记完整分类和值，后续按完整分类回指。未要求数值对比报告时，只交付所需角色和 token；仍在内部核验实际色对的可读性。确需报告比值时，只使用实际前景色、实际背景色、计算值三项，发出前逐项与最终 token 一致核对，不能换成背景形容词。上述记录和核对收在用户允许内容里，不外发执行过程。

配色终稿按来源表逐句归类：观察记录返回的界面事实才进入参考观察；style-system.md 的规则、默认和 token 说明全部进入本次转译建议。先实际移走错栏句子，再交付正文，不把“不是实测”的解释附在观察栏。原请求没指定某历史值时，不在请求项中裸列该值；历史来源完整分类和值单独登记，原格式与条数不变。

先在允许的来源字段登记任务已给出的历史颜色，即使本次不采用，也要在原始请求或当前源码项中写出其完整历史来源分类与值；不能等到结论才补登记。当前团队采用提案另写，后续依据、决定和未来条件都用原完整分类名回指历史项，用“当前团队提案”回指新提案，不能把二者合成“该颜色／该绿色”。

来源字段填写后再写决定。若说明非用户主体确认的既有决定，直接写出其资格来源的种类：用户指示或任务前既有项目记录；未提供就明确缺口，不能只写“资格的独立来源”或“可追溯资格”。用户本人当前指定或保留仍直接执行，不增加审批。

参考观察字段仅写观察记录的具体页面／组件／状态事实及未观察边界。读到指南如何分类 token 的说明，包括“指南说不是实测”的否定解释，仍是指南内容，必须写到本次转译建议字段；不得附在参考观察末尾。

配色交付先填写来源，再给设计决定。开场结论也属于正文：第一次出现历史颜色时，先写完整来源分类再给值；当前团队提案另列。后续讨论该历史项用同一完整分类回指，不在开场、否定句或未来条件中裸用历史值。用户当前确定的新决定按其当前范围独立记录。

参考观察字段只放已读材料的命名页面／组件、状态和具体事实。每条事实都能定位组件；泛称浅色表面、选中态、行内错误或退出行为而不说明对应组件不够。指南中的默认值、token、动作和反馈建议，以及解释这些建议不属实测的句子，均放在本次转译建议字段，不挤入参考观察字段。

适用的配色输出都须实填来源，不因它是整体设计方案、固定条数或 HTML 规格而省略：原始请求、当前源码颜色、参考观察、已确认品牌、本次转译建议。把五项合并为现有条目内的短句或 token 注释；源码／品牌未提供就写未提供或未确认，观察写已读文件／版本、命名组件和具体状态事实。只把当前数值叫作“转译建议”仍缺其余来源事实。纯非配色任务不为此新增内容。

## 适用边界

先确定原请求允许的最终内容，再在该范围内完成来源记录和决定；设计方案与只读审查由当前执行者直接完成。完整读取所需材料后，不反复探查已经获得的文件或另起无关工作流；仅在确有事实缺口时补读。

历史颜色的“完整来源分类＋值”作为一条不可拆的引用，仅在首次登记时给值，后续决定用相同完整分类名回指；当前品牌值另列。最终正文无需再次复述历史色号，不能在最后一句删去已有分类。观察引用同样保留已读文件／版本、具体页面或组件以及状态事实，收在用户允许的原条目中。

代码片段发现语法或值错误时，先把更正合入主要代码块，再发送最终内容；不要交付仍含错误的主代码块并让读者拼接后面的修正。仅按原请求报告已完成的工作，不把读取成功当作实现或验收完成。

用户限定颜色 token、按钮决定或其他组件范围时，只提供这些组件实际采用的角色与 token，不附未使用的全局调色板、强调色或其他组件方案。操作强调色的使用限制按角色 token、请求组件和状态表述，不把同一种颜色在整个产品中的所有用途合并为排他规则。
只要求颜色 token 和按钮决定时，优先用四列表格把按钮、状态、token 与色值放在同一行。若用户要求 CSS，再用代码块列 `:root` token：先确定两枚按钮的实际状态映射，只定义这些映射引用的 token；代码块之后逐字引用每个 token 并说明对应按钮状态。写“白底”不等于引用 `--action-secondary-bg`，必须写出 token 名或删掉该定义。仅在代码注释中泛称“深色实心”或列出少数状态，不算完成全部 token 的使用决定。

来源审查中，用户本人当次明确指定或保留颜色是直接决定，无需证明职务或再次确认；其他确认主体的资格须能由用户指示或任务前既有项目记录确定，且独立于本次实施者自写的代码、README 与验收合同。记录具体资格依据，不能用自称身份循环证明。已读指南中的 token、动作状态、反馈文案及图标均属目标产品的当前转译建议，不属参考实测；在来源分类中说明此性质，实际采用项按角色分别记录，不为此添加原请求以外的界面设计。
