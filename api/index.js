/**
 * C 起点学习网站 AI 后端 — Deno Deploy 版
 *
 * 等价实现 server.py 的 API，供 GitHub Pages 版学习网站调用：
 *   GET  /api/health   健康检查（返回 provider / configured / requiresToken）
 *   POST /api/generate 调用 DeepSeek 生成挑战题
 *   POST /api/run      调用 Wandbox 在线判题（C 程序）
 *
 * 环境变量（在 Deno Deploy 项目 Settings → Environment Variables 中设置）：
 *   DEEPSEEK_API_KEY  DeepSeek 开放平台 API Key（必填）
 *   DEEPSEEK_MODEL    模型名，默认 deepseek-flash（非思考档）
 *   SITE_API_TOKEN 后端访问口令，至少 32 字符（Secret，公网必填）
 *   ALLOWED_ORIGINS 允许的网页来源，多个用逗号分隔，
 *                   默认 https://nb66666708.github.io
 *
 * 注意：DeepSeek 调用设 90 秒超时；非思考档通常十几秒内返回。
 */

const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";
const WANDBOX_URL = "https://wandbox.org/api/compile.json";
const WANDBOX_COMPILER = "gcc-13.2.0-c";

const MAX_BODY_BYTES = 256_000;
const MAX_COURSES = 200;
const RATE_WINDOW_SECONDS = 60;
const RATE_LIMIT_GENERATE = 5;
const RATE_LIMIT_JUDGE = 8;
const MAX_SOURCE_BYTES = 32_000;
const MAX_TEST_CASES = 5;
const MAX_TEST_INPUT_BYTES = 4_000;
const MAX_EXPECTED_OUTPUT_BYTES = 2_000;

const encoder = new TextEncoder();

function bytesLength(value) {
  return encoder.encode(value).length;
}

function cleanText(value, limit) {
  if (typeof value !== "string") return "";
  return value.split(/\s+/).filter(Boolean).join(" ").slice(0, limit);
}

function truncateText(value, limit) {
  return typeof value === "string" ? value.slice(0, limit) : "";
}

function parseAllowedOrigins(raw) {
  const value = (raw || "https://nb66666708.github.io")
    .split(",")
    .map((item) => item.trim().replace(/\/+$/, ""))
    .filter(Boolean);
  return new Set(value);
}

async function timingSafeEqual(a, b) {
  const digest = async (value) => {
    const buffer = await crypto.subtle.digest("SHA-256", encoder.encode(value));
    return new Uint8Array(buffer);
  };
  const left = await digest(a);
  const right = await digest(b);
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index++) diff |= left[index] ^ right[index];
  return diff === 0;
}

class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ---------- 请求校验（对应 server.py validate_request） ----------
function validateRequest(payload) {
  if (!payload || typeof payload !== "object") {
    throw new RequestError(400, "请求格式无效。");
  }

  const count = payload.count;
  if (count !== 5 && count !== 10 && count !== 20 && count !== 30) {
    throw new RequestError(400, "每次挑战只能生成 5/10/20/30 道题。");
  }

  const courses = payload.courses;
  if (!Array.isArray(courses) || courses.length < 1 || courses.length > MAX_COURSES) {
    throw new RequestError(400, "课程资料为空或格式无效。");
  }

  const cleaned = [];
  for (const course of courses) {
    if (!course || typeof course !== "object") continue;
    const title = cleanText(course.title, 120);
    if (!title) continue;
    const topics = Array.isArray(course.topics) ? course.topics : [];
    cleaned.push({
      title,
      level: cleanText(course.level, 80),
      topics: topics
        .filter((topic) => typeof topic === "string")
        .slice(0, 12)
        .map((topic) => cleanText(topic, 500)),
      summary: cleanText(course.summary, 1400),
    });
  }

  if (cleaned.length === 0) {
    throw new RequestError(400, "没有可用的课程内容。");
  }
  return { count, courses: cleaned };
}

// ---------- 题目校验（对应 server.py validate_questions） ----------
function validateQuestions(content, count) {
  let raw = [];
  if (Array.isArray(content)) raw = content;
  else if (content && Array.isArray(content.questions)) raw = content.questions;
  else throw new RequestError(502, "AI 返回的题目格式无效，请重新生成。");
  if (raw.length !== count) {
    throw new RequestError(502, `AI 返回了 ${raw.length} 道题，预期 ${count} 道；请重新生成。`);
  }

  const validated = [];
  const seen = new Set();
  for (let index = 0; index < raw.length; index++) {
    try {
      const question = raw[index];
      if (!question || typeof question !== "object") {
        throw new RequestError(502, `第 ${index + 1} 题格式无效，请重新生成。`);
      }

      const questionType = question.type;
      const text = cleanText(question.text, 500);
      if (!["选择题", "判断题", "填空题", "程序题"].includes(questionType) || !text) {
        throw new RequestError(502, `第 ${index + 1} 题题型或题干无效，请重新生成。`);
      }

      const knowledge = cleanText(question.knowledge, 160);
      const explanation = cleanText(question.explanation, 700);
      const pitfall = cleanText(question.pitfall, 400);
      if (!knowledge || !explanation || !pitfall) {
        throw new RequestError(502, `第 ${index + 1} 题缺少知识点、解析或易错点，请重新生成。`);
      }

      const signature = text.toLowerCase().replace(/\s+/g, " ").trim();
      if (seen.has(signature)) throw new RequestError(502, "AI 返回了重复题目，请重新生成。");
      seen.add(signature);

      const result = { type: questionType, text, knowledge, explanation, pitfall };

      if (questionType === "选择题" || questionType === "判断题") {
        let opts = Array.isArray(question.options) ? question.options.map((o) => cleanText(o, 220)).filter((o) => o) : [];
        if (opts.length < 2 || opts.length > 5 ||
            new Set(opts.map((option) => option.toLowerCase())).size !== opts.length) {
          throw new RequestError(502, `第 ${index + 1} 题的选项为空、重复或数量无效，请重新生成。`);
        }
        if (questionType === "判断题" && (opts.length !== 2 || opts[0] !== "正确" || opts[1] !== "错误")) {
          throw new RequestError(502, `第 ${index + 1} 题的判断选项格式无效，请重新生成。`);
        }
        const answer = Number.isInteger(question.answer) ? question.answer : -1;
        if (answer < 0 || answer >= opts.length) {
          throw new RequestError(502, `第 ${index + 1} 题的标准答案无效，请重新生成。`);
        }
        result.options = opts;
        result.answer = answer;
      } else if (questionType === "填空题") {
        let accepted = Array.isArray(question.accepted) ? question.accepted.map((a) => cleanText(a, 100)).filter((a) => a) : [];
        if (!accepted.length || accepted.length > 5 ||
            new Set(accepted.map((a) => a.toLowerCase())).size !== accepted.length) {
          throw new RequestError(502, `第 ${index + 1} 题的填空答案无效，请重新生成。`);
        }
        result.accepted = accepted;
      } else {
        const solution = typeof question.solution === "string" ? question.solution.trim() : "";
        if (!solution || solution.length > 3000) {
          throw new RequestError(502, `第 ${index + 1} 题缺少合理长度的参考代码，请重新生成。`);
        }
        result.solution = solution;
        const tests = Array.isArray(question.tests) ? question.tests.filter((t) => t && typeof t === "object" && typeof t.input === "string" && typeof t.output === "string").slice(0, MAX_TEST_CASES) : [];
        if (tests.length < 2 || tests.length > MAX_TEST_CASES) {
          throw new RequestError(502, `第 ${index + 1} 题缺少有效的自动判分测试，请重新生成。`);
        }
        result.tests = tests.map((t) => ({ input: t.input, output: t.output }));
      }
      validated.push(result);
      } catch (error) {
        if (error instanceof RequestError) throw error;
        throw new RequestError(502, `第 ${index + 1} 题校验失败，请重新生成。`);
      }
  }

  if (validated.length < 5) {
    throw new RequestError(502, "AI 返回的有效题目太少（" + validated.length + " 道），请重新生成。");
  }
  return validated;
}

// ---------- 判题请求校验（对应 server.py validate_judge_request） ----------
function validateJudgeRequest(payload) {
  if (!payload || typeof payload !== "object") {
    throw new RequestError(400, "判题请求格式无效。");
  }
  const source = payload.source;
  const tests = payload.tests;
  if (typeof source !== "string" || !source.trim()) {
    throw new RequestError(400, "请先编写 C 程序。");
  }
  if (bytesLength(source) > MAX_SOURCE_BYTES) {
    throw new RequestError(413, "程序太长，请将代码控制在 32 KB 以内。");
  }
  if (!Array.isArray(tests) || tests.length < 1 || tests.length > MAX_TEST_CASES) {
    throw new RequestError(400, "测试数据格式无效。");
  }

  const validatedTests = [];
  for (let index = 0; index < tests.length; index++) {
    const test = tests[index];
    if (!test || typeof test !== "object") {
      throw new RequestError(400, `第 ${index + 1} 组测试格式无效。`);
    }
    const testInput = test.input ?? "";
    const expectedOutput = test.output;
    if (typeof testInput !== "string" || typeof expectedOutput !== "string") {
      throw new RequestError(400, `第 ${index + 1} 组测试输入和期望输出必须是文本。`);
    }
    if (bytesLength(testInput) > MAX_TEST_INPUT_BYTES) {
      throw new RequestError(413, `第 ${index + 1} 组测试输入过长。`);
    }
    if (bytesLength(expectedOutput) > MAX_EXPECTED_OUTPUT_BYTES) {
      throw new RequestError(413, `第 ${index + 1} 组期望输出过长。`);
    }
    validatedTests.push({ input: testInput, output: expectedOutput });
  }
  return { source, tests: validatedTests };
}

// ---------- Wandbox 判题（对应 server.py execute_c / judge_c_program） ----------
function normalizeOutput(value) {
  return String(value)
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .trim();
}

async function fetchWandbox(source, testInput, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(WANDBOX_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": "Mozilla/5.0",
        Origin: "https://wandbox.org",
        Referer: "https://wandbox.org/",
      },
      body: JSON.stringify({
        compiler: WANDBOX_COMPILER,
        code: source,
        stdin: testInput,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const details = cleanText(await response.text(), 400);
      if (response.status === 429 || response.status === 503) {
        throw new RequestError(503, "在线判题服务暂时繁忙，请稍后重试。");
      }
      throw new RequestError(502, `在线判题服务返回 HTTP ${response.status}。${details}`);
    }

    const result = await response.json();
    const requiredTextFields = ["status", "signal", "compiler_error", "program_output", "program_error"];
    if (!result || typeof result !== "object" || requiredTextFields.some((field) => typeof result[field] !== "string")) {
      throw new RequestError(502, "在线判题服务的运行结果格式无效。");
    }
    return result;
  } catch (error) {
    if (error instanceof RequestError) throw error;
    throw new RequestError(502, "无法连接在线判题服务或请求超时，请稍后重试。");
  } finally {
    clearTimeout(timer);
  }
}

async function judgeCProgram(source, tests) {
  // 各组测试彼此独立，并行提交以控制在 Worker 30 秒墙钟内；结果按原顺序判定
  const settled = await Promise.allSettled(
    tests.map((test) => fetchWandbox(source, test.input, 20_000))
  );

  for (let index = 0; index < tests.length; index++) {
    const test = tests[index];
    if (settled[index].status === "rejected") {
      throw settled[index].reason instanceof RequestError
        ? settled[index].reason
        : new RequestError(502, "在线判题失败，请稍后重试。");
    }
    const result = settled[index].value;
    const compilerOutput = result.compiler_error || result.compiler_output || "";
    if (compilerOutput) {
      const serviceError = compilerOutput.toLowerCase();
      if (serviceError.includes("oci runtime error") || serviceError.includes("resource temporarily unavailable")) {
        throw new RequestError(503, "在线判题服务暂时繁忙，请稍后重试。");
      }
    }

    if (result.signal) {
      return {
        status: "runtime_error",
        message: "程序被判题沙箱终止，可能是运行超时或资源超限。",
        runtimeOutput: truncateText(result.program_error || result.program_message || "", 4000),
      };
    }

    let exitCode = 0;
    try {
      exitCode = Number.parseInt(result.status, 10);
      if (Number.isNaN(exitCode)) throw new Error("not a number");
    } catch (_error) {
      throw new RequestError(502, "在线判题服务返回了无效的程序退出状态。");
    }

    if (exitCode !== 0 && compilerOutput) {
      return {
        status: "compile_error",
        message: "编译未通过，请阅读错误信息并修改程序。",
        compilerOutput: truncateText(compilerOutput, 5000),
      };
    }
    if (exitCode !== 0) {
      return {
        status: "runtime_error",
        message: `程序异常退出（测试 ${index + 1}）。`,
        runtimeOutput: truncateText(result.program_error || result.program_message || "", 4000),
      };
    }

    const actualOutput = truncateText(result.program_output, 4000);
    if (normalizeOutput(actualOutput) !== normalizeOutput(test.output)) {
      return {
        status: "wrong_answer",
        message: `第 ${index + 1} 组测试未通过。`,
        passedTests: index,
        totalTests: tests.length,
        expectedOutput: truncateText(test.output, 2000),
        actualOutput,
      };
    }
  }

  return {
    status: "accepted",
    message: `全部 ${tests.length} 组测试通过！`,
    passedTests: tests.length,
    totalTests: tests.length,
  };
}

// ---------- DeepSeek 出题（对应 server.py generate_questions） ----------
async function generateQuestions(env, count, courses, variation) {
  const apiKey = (env.DEEPSEEK_API_KEY || "").trim();
  if (!apiKey) {
    throw new RequestError(503, "尚未配置 DeepSeek API Key。请在后端环境变量中设置 DEEPSEEK_API_KEY。");
  }
  const model = (env.DEEPSEEK_MODEL || "deepseek-flash").trim();

  const systemPrompt = [
    "你是严谨的中文 C 语言与 STM32 教学出题老师。",
    "你的任务不是复述课程例题，而是围绕课程知识点做扩展、进阶与强化：同一知识点要换角度、换场景、换数据考查，适当出综合应用、易错辨析、代码结果分析、实际工程情境题，帮助用户把知识学透。",
    "题目必须落在课程知识点及其直接延伸范围内，不能引入与课程无关的全新主题；可以综合本课多个知识点，或把知识点用到新的代码/场景中。",
    "严禁照搬课程已有题目，也禁止只改几个数字就当作新题；用户会提供本课已有题干清单，生成的题目不得与其中任何一道重复或仅做措辞改动。",
    "题目表达清晰、条件充分、答案唯一且可验证；涉及代码的选择/填空题必须在题干中给出完整可判断的代码片段，缺关键条件时先按常见写法补全并注明（此处为假设代码）。",
    "覆盖不同课程主题与难度，避免重复考查同一事实。",
    "每题必须自查题意和标准答案；错误选项应合理但明确错误。",
    "只生成选择题、判断题、填空题，不要程序题。",
    "三种题型都尽量覆盖，避免重复考查同一事实。",
    "判断题选项必须严格为“正确”“错误”。填空题需在题干标出 ____ 空位并给出 accepted 答案列表。",
    "选择/判断题使用 options 和从 0 开始的整数 answer；填空题使用 accepted。",
    "每题包含知识点、一句话解析和一个简短易错点，不要长篇展开。",
    "只输出符合要求的 JSON 对象，不要 Markdown 或额外文字。",
  ].join("");

  const outputSchema = '{"questions":[{"type":"选择题","text":"题干","options":["A","B","C","D"],"answer":0,"knowledge":"知识点","explanation":"解析","pitfall":"易错点"}]}';

  const userPrompt = [
    `生成 ${count} 道题，选择、判断、填空混合，不要程序题。`,
    "要求：围绕课程知识点做扩展与进阶，多出综合应用、代码分析、易错辨析题；不要重复本课已有题目（见资料中 existingQuestions），也不要只改数字凑题。",
    `格式：${outputSchema}`,
    `变化标识：${cleanText(variation, 80)}`,
    `课程资料：${JSON.stringify(courses)}`,
  ].join("");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90_000);
  try {
    const response = await fetch(DEEPSEEK_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        temperature: 0.6,
        max_tokens: 4096,
        thinking: { type: "disabled" },
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorBody = await response.text();
      let providerMessage = "";
      try {
        providerMessage = JSON.parse(errorBody)?.error?.message || "";
      } catch (_error) {
        providerMessage = "";
      }
      if (response.status === 401 || response.status === 403) {
        throw new RequestError(502, "DeepSeek API Key 无效或没有访问权限，请检查服务端密钥配置。");
      }
      if (response.status === 402) {
        throw new RequestError(502, "DeepSeek 账户余额不足或模型不可用，请检查账号余额及模型权限。");
      }
      if (response.status === 429) {
        throw new RequestError(502, "DeepSeek API 请求频率达到限制或服务暂时繁忙，请稍后重试。");
      }
      const detail = cleanText(providerMessage, 240);
      throw new RequestError(502, `DeepSeek API 请求失败（HTTP ${response.status}）。${detail}`);
    }

    const providerResponse = await response.json();
    const content = providerResponse?.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      throw new RequestError(502, "AI 返回内容不是预期的 JSON 题目格式，请重试。");
    }
    let decoded;
    try {
      let raw = content.trim();
      const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
      if (fence) raw = fence[1].trim();
      const start = raw.indexOf("[");
      const end = raw.lastIndexOf("]");
      if (start >= 0 && end > start) raw = raw.slice(start, end + 1);
      decoded = JSON.parse(raw);
      if (Array.isArray(decoded)) decoded = { questions: decoded };
    } catch (_error) {
      console.error("JSON parse failed, content head:", content.slice(0, 500));
      throw new RequestError(502, "AI 返回不是 JSON。返回开头：" + content.slice(0, 200));
    }
    return validateQuestions(decoded, count);
  } catch (error) {
    if (error instanceof RequestError) throw error;
    if (error.name === "AbortError") {
      throw new RequestError(502, "出题超时已中断，请稍后重试；非思考档通常十几秒内完成。");
    }
    throw new RequestError(502, "无法连接 DeepSeek 服务或请求超时，请检查网络后重试。");
  } finally {
    clearTimeout(timer);
  }
}

// ---------- 限流（对应 server.py 限流逻辑） ----------
const rateBuckets = new Map();
function checkRateLimit(clientIp, path) {
  const isGenerate = path === "/api/generate";
  const windowMs = RATE_WINDOW_SECONDS * 1000;
  const limit = isGenerate ? RATE_LIMIT_GENERATE : RATE_LIMIT_JUDGE;
  const rateError = isGenerate
    ? "请求太频繁，请稍等一分钟后再生成。"
    : "判题请求太频繁，请等一分钟后再试。";

  const now = Date.now();
  const bucket = rateBuckets.get(clientIp) || [];
  const recent = bucket.filter((when) => now - when < windowMs);
  if (recent.length >= limit) {
    throw new RequestError(429, rateError);
  }
  recent.push(now);
  rateBuckets.set(clientIp, recent);
}

async function readBodyWithLimit(request, maxBytes) {
  // 流式读取并限制体积：不依赖 Content-Length 头（部分客户端/运行时不会携带）
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new RequestError(413, "请求内容为空或过大。");
      }
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
  if (total === 0) {
    throw new RequestError(413, "请求内容为空或过大。");
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

// ---------- HTTP 处理 ----------
function jsonResponse(status, payload, origin) {
  const body = JSON.stringify(payload);
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  };
  if (origin) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Vary"] = "Origin";
  }
  return new Response(body, { status, headers });
}

async function handleRequest(request, env) {
  const url = new URL(request.url);
  const origin = (request.headers.get("Origin") || "").replace(/\/+$/, "") || null;
  const allowedOrigins = parseAllowedOrigins(env.ALLOWED_ORIGINS);
  const allowedOrigin = origin && allowedOrigins.has(origin) ? origin : null;
  const clientIp =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("CF-Connecting-IP") ||
    "unknown";

  // OPTIONS 预检：仅允许已知来源访问业务接口
  if (request.method === "OPTIONS") {
    if (!["/api/generate", "/api/run"].includes(url.pathname) || !allowedOrigin) {
      return jsonResponse(403, { error: "该网站来源不允许访问此服务。" }, allowedOrigin);
    }
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": allowedOrigin,
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Access-Control-Max-Age": "600",
        "Vary": "Origin",
      },
    });
  }

  // GET：健康检查
  if (request.method === "GET") {
    if (url.pathname !== "/api/health") {
      return jsonResponse(404, { error: "Not Found" }, allowedOrigin);
    }
    return jsonResponse(200, {
      ok: true,
      provider: "DeepSeek",
      configured: Boolean((env.DEEPSEEK_API_KEY || "").trim()),
      requiresToken: Boolean((env.SITE_API_TOKEN || "").trim()),
    }, allowedOrigin);
  }

  // POST：业务接口
  if (request.method !== "POST") {
    return jsonResponse(405, { error: "Method Not Allowed" }, allowedOrigin);
  }
  if (!["/api/generate", "/api/run"].includes(url.pathname)) {
    return jsonResponse(404, { error: "Not Found" }, allowedOrigin);
  }

  if (!allowedOrigin) {
    return jsonResponse(403, { error: "该网站来源不允许访问此服务。" }, null);
  }

  const siteToken = (env.SITE_API_TOKEN || "").trim();
  if (siteToken) {
    const authorization = request.headers.get("Authorization") || "";
    const supplied = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
    if (!supplied || !(await timingSafeEqual(supplied, siteToken))) {
      return jsonResponse(401, { error: "后端访问口令无效，请在 AI 连接设置中检查口令。" }, allowedOrigin);
    }
  }
  // 个人自用：未配置 SITE_API_TOKEN 时直接放行。

  const contentType = request.headers.get("Content-Type") || "";
  if (contentType.split(";")[0].trim().toLowerCase() !== "application/json") {
    return jsonResponse(415, { error: "请求必须使用 application/json 格式。" }, allowedOrigin);
  }

  try {
    checkRateLimit(clientIp, url.pathname);

    const bodyText = await readBodyWithLimit(request, MAX_BODY_BYTES);
    let payload;
    try {
      payload = JSON.parse(bodyText);
    } catch (_error) {
      throw new RequestError(400, "请求不是有效的 JSON 数据。");
    }

    if (url.pathname === "/api/generate") {
      const { count, courses } = validateRequest(payload);
      const variation = typeof payload.variation === "string" ? cleanText(payload.variation, 80) : "";
      const questions = await generateQuestions(env, count, courses, variation);
      return jsonResponse(200, { questions }, allowedOrigin);
    }

    const { source, tests } = validateJudgeRequest(payload);
    return jsonResponse(200, await judgeCProgram(source, tests), allowedOrigin);
  } catch (error) {
    console.error("API error:", error?.message || String(error));
    if (error instanceof RequestError) {
      return jsonResponse(error.status, { error: error.message }, allowedOrigin);
    }
    if (error instanceof SyntaxError) {
      return jsonResponse(400, { error: "请求不是有效的 JSON 数据。" }, allowedOrigin);
    }
    return jsonResponse(500, { error: "服务器错误：" + String(error?.message || error) }, allowedOrigin);
  }
}

// ---------- Deno Deploy 入口 ----------
const env = {
  DEEPSEEK_API_KEY: Deno.env.get("DEEPSEEK_API_KEY") || "",
  DEEPSEEK_MODEL: Deno.env.get("DEEPSEEK_MODEL") || "",
  SITE_API_TOKEN: Deno.env.get("SITE_API_TOKEN") || "",
  ALLOWED_ORIGINS: Deno.env.get("ALLOWED_ORIGINS") || "",
};

Deno.serve((request) => handleRequest(request, env));
