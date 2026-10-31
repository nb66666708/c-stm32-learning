import json
import hmac
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parent
HOST = os.environ.get("HOST", "127.0.0.1")
PORT = int(os.environ.get("PORT", os.environ.get("C_START_PORT", "8000")))
AI_PROVIDER = os.environ.get("AI_PROVIDER", "deepseek").strip().lower()
AI_PROVIDERS = {
    "deepseek": {
        "name": "DeepSeek",
        "url": "https://api.deepseek.com/chat/completions",
        "model": os.environ.get("DEEPSEEK_MODEL", "deepseek-flash"),
        "key_env": "DEEPSEEK_API_KEY",
    },
    "zhipu": {
        "name": "智谱 GLM",
        "url": "https://open.bigmodel.cn/api/paas/v4/chat/completions",
        "model": os.environ.get("ZHIPU_MODEL", "glm-4.7-flash"),
        "key_env": "ZHIPU_API_KEY",
    },
}
SITE_API_TOKEN = os.environ.get("SITE_API_TOKEN", "").strip()
ALLOWED_ORIGINS = {
    origin.strip().rstrip("/")
    for origin in os.environ.get(
        "ALLOWED_ORIGINS", f"http://127.0.0.1:{PORT},http://localhost:{PORT}"
    ).split(",")
    if origin.strip()
}
MAX_BODY_BYTES = 256_000
MAX_COURSES = 60
RATE_WINDOW_SECONDS = 60
RATE_LIMIT = 5
JUDGE_WINDOW_SECONDS = 60
JUDGE_RATE_LIMIT = 8
MAX_SOURCE_BYTES = 32_000
MAX_TEST_CASES = 5
MAX_TEST_INPUT_BYTES = 4_000
MAX_EXPECTED_OUTPUT_BYTES = 2_000
WANDBOX_COMPILE_URL = "https://wandbox.org/api/compile.json"
WANDBOX_C_COMPILER = "gcc-13.2.0-c"
rate_lock = threading.Lock()
request_times = {}
judge_lock = threading.Lock()
judge_request_times = {}


class RequestError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


def clean_text(value, limit):
    if not isinstance(value, str):
        return ""
    return " ".join(value.split())[:limit]


def truncate_text(value, limit):
    return value[:limit] if isinstance(value, str) else ""


def active_provider():
    provider = AI_PROVIDERS.get(AI_PROVIDER)
    if provider is None:
        raise RequestError(503, "AI_PROVIDER 配置无效，请设置为 deepseek 或 zhipu。")
    return provider


def validate_request(payload):
    if not isinstance(payload, dict):
        raise RequestError(400, "请求格式无效。")

    count = payload.get("count")
    if count not in (5, 10, 20, 30):
        raise RequestError(400, "每次挑战只能生成 5、10、20 或 30 道题。")

    courses = payload.get("courses")
    if not isinstance(courses, list) or not 1 <= len(courses) <= MAX_COURSES:
        raise RequestError(400, "课程资料为空或格式无效。")

    cleaned = []
    for course in courses:
        if not isinstance(course, dict):
            continue
        title = clean_text(course.get("title"), 120)
        if not title:
            continue
        topics = course.get("topics", [])
        if not isinstance(topics, list):
            topics = []
        cleaned.append({
            "title": title,
            "level": clean_text(course.get("level"), 80),
            "topics": [clean_text(topic, 500) for topic in topics[:12] if isinstance(topic, str)],
            "summary": clean_text(course.get("summary"), 1400),
        })

    if not cleaned:
        raise RequestError(400, "没有可用的课程内容。")
    return count, cleaned


def validate_questions(content, count):
    if not isinstance(content, dict) or not isinstance(content.get("questions"), list):
        raise RequestError(502, "AI 返回的题目格式无效，请重新生成。")

    questions = content["questions"]
    if len(questions) != count:
        raise RequestError(502, f"AI 返回了 {len(questions)} 道题，预期 {count} 道；请重新生成。")

    validated = []
    seen = set()
    for index, question in enumerate(questions):
        if not isinstance(question, dict):
            raise RequestError(502, f"第 {index + 1} 题格式无效，请重新生成。")

        question_type = question.get("type")
        text = clean_text(question.get("text"), 500)
        options = question.get("options")
        answer = question.get("answer")
        knowledge = clean_text(question.get("knowledge"), 160)
        explanation = clean_text(question.get("explanation"), 700)
        pitfall = clean_text(question.get("pitfall"), 400)

        if question_type not in ("选择题", "判断题", "填空题", "程序题"):
            raise RequestError(502, f"第 {index + 1} 题的题型无效，请重新生成。")
        if not text or not knowledge or not explanation or not pitfall:
            raise RequestError(502, f"第 {index + 1} 题缺少题目、知识点、解析或易错点。")

        signature = text.casefold()
        if signature in seen:
            raise RequestError(502, "AI 返回了重复题目，请重新生成。")
        seen.add(signature)
        result = {
            "type": question_type,
            "text": text,
            "knowledge": knowledge,
            "explanation": explanation,
            "pitfall": pitfall,
        }
        if question_type in ("选择题", "判断题"):
            if not isinstance(options, list) or not 2 <= len(options) <= 5:
                raise RequestError(502, f"第 {index + 1} 题的选项数量无效。")
            options = [clean_text(option, 220) for option in options]
            if any(not option for option in options) or len(set(options)) != len(options):
                raise RequestError(502, f"第 {index + 1} 题的选项为空或重复。")
            if question_type == "判断题" and options != ["正确", "错误"]:
                raise RequestError(502, f"第 {index + 1} 题的判断选项格式无效。")
            if not isinstance(answer, int) or isinstance(answer, bool) or not 0 <= answer < len(options):
                raise RequestError(502, f"第 {index + 1} 题的标准答案无效。")
            result.update({"options": options, "answer": answer})
        elif question_type == "填空题":
            accepted = question.get("accepted")
            if not isinstance(accepted, list) or not 1 <= len(accepted) <= 5:
                raise RequestError(502, f"第 {index + 1} 题的填空答案无效。")
            accepted = [clean_text(value, 100) for value in accepted]
            if any(not value for value in accepted) or len(set(value.casefold() for value in accepted)) != len(accepted):
                raise RequestError(502, f"第 {index + 1} 题的填空答案为空或重复。")
            result["accepted"] = accepted
        else:
            solution = question.get("solution")
            if not isinstance(solution, str) or not solution.strip() or len(solution) > 3000:
                raise RequestError(502, f"第 {index + 1} 题缺少合理长度的参考代码。")
            result["solution"] = solution.strip()
            tests = question.get("tests")
            if not isinstance(tests, list) or not 2 <= len(tests) <= MAX_TEST_CASES:
                raise RequestError(502, f"第 {index + 1} 题缺少 2 至 {MAX_TEST_CASES} 组自动判分测试。")
            validated_tests = []
            for test in tests:
                if not isinstance(test, dict):
                    raise RequestError(502, f"第 {index + 1} 题测试用例格式无效。")
                test_input = test.get("input", "")
                expected_output = test.get("output")
                if not isinstance(test_input, str) or not isinstance(expected_output, str):
                    raise RequestError(502, f"第 {index + 1} 题测试输入和期望输出必须是文本。")
                if len(test_input.encode("utf-8")) > MAX_TEST_INPUT_BYTES:
                    raise RequestError(502, f"第 {index + 1} 题测试输入过长。")
                if len(expected_output.encode("utf-8")) > MAX_EXPECTED_OUTPUT_BYTES:
                    raise RequestError(502, f"第 {index + 1} 题期望输出过长。")
                validated_tests.append({"input": test_input, "output": expected_output})
            if len({(case["input"], case["output"]) for case in validated_tests}) != len(validated_tests):
                raise RequestError(502, f"第 {index + 1} 题包含重复测试数据。")
            result["tests"] = validated_tests
        validated.append(result)

    minimum_per_type = max(2, count // 10)
    for question_type in ("选择题", "判断题", "填空题", "程序题"):
        type_count = sum(question["type"] == question_type for question in validated)
        if type_count < minimum_per_type:
            raise RequestError(502, f"AI 生成的{question_type}太少，题型需要更均衡；请重新生成。")
    return validated


def validate_judge_request(payload):
    if not isinstance(payload, dict):
        raise RequestError(400, "判题请求格式无效。")
    source = payload.get("source")
    tests = payload.get("tests")
    if not isinstance(source, str) or not source.strip():
        raise RequestError(400, "请先编写 C 程序。")
    if len(source.encode("utf-8")) > MAX_SOURCE_BYTES:
        raise RequestError(413, "程序太长，请将代码控制在 32 KB 以内。")
    if not isinstance(tests, list) or not 1 <= len(tests) <= MAX_TEST_CASES:
        raise RequestError(400, "测试数据格式无效。")

    validated_tests = []
    for index, test in enumerate(tests):
        if not isinstance(test, dict):
            raise RequestError(400, f"第 {index + 1} 组测试格式无效。")
        test_input = test.get("input", "")
        expected_output = test.get("output")
        if not isinstance(test_input, str) or not isinstance(expected_output, str):
            raise RequestError(400, f"第 {index + 1} 组测试输入和期望输出必须是文本。")
        if len(test_input.encode("utf-8")) > MAX_TEST_INPUT_BYTES:
            raise RequestError(413, f"第 {index + 1} 组测试输入过长。")
        if len(expected_output.encode("utf-8")) > MAX_EXPECTED_OUTPUT_BYTES:
            raise RequestError(413, f"第 {index + 1} 组期望输出过长。")
        validated_tests.append({"input": test_input, "output": expected_output})
    return source, validated_tests


def normalize_output(value):
    return "\n".join(line.rstrip() for line in value.replace("\r\n", "\n").replace("\r", "\n").splitlines()).strip()


def execute_c(source, test_input):
    payload = {
        "compiler": WANDBOX_C_COMPILER,
        "code": source,
        "stdin": test_input,
    }
    request = Request(
        WANDBOX_COMPILE_URL,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": "Mozilla/5.0",
            "Origin": "https://wandbox.org",
            "Referer": "https://wandbox.org/",
        },
        method="POST",
    )
    try:
        with urlopen(request, timeout=20) as response:
            response_body = response.read(128_000 + 1)
            if len(response_body) > 128_000:
                raise RequestError(502, "在线判题服务返回的数据过大。")
            result = json.loads(response_body.decode("utf-8"))
    except HTTPError as error:
        details = clean_text(error.read(2000).decode("utf-8", errors="replace"), 400)
        status = 503 if error.code in (429, 503) else 502
        message = "在线判题服务暂时繁忙，请稍后重试。" if status == 503 else f"在线判题服务返回 HTTP {error.code}。{details}"
        raise RequestError(status, message) from error
    except (URLError, TimeoutError) as error:
        raise RequestError(502, "无法连接在线判题服务或请求超时，请稍后重试。") from error
    except (json.JSONDecodeError, UnicodeDecodeError) as error:
        raise RequestError(502, "在线判题服务返回了无法读取的数据。") from error
    required_text_fields = ("status", "signal", "compiler_error", "program_output", "program_error")
    if not isinstance(result, dict) or any(not isinstance(result.get(field), str) for field in required_text_fields):
        raise RequestError(502, "在线判题服务的运行结果格式无效。")
    return result


def judge_c_program(source, tests):
    for index, test in enumerate(tests, start=1):
        result = execute_c(source, test["input"])
        compiler_output = result["compiler_error"] or result.get("compiler_output", "")
        if compiler_output:
            service_error = compiler_output.casefold()
            if "oci runtime error" in service_error or "resource temporarily unavailable" in service_error:
                raise RequestError(503, "在线判题服务暂时繁忙，请稍后重试。")

        if result["signal"]:
            return {
                "status": "runtime_error",
                "message": "程序被判题沙箱终止，可能是运行超时或资源超限。",
                "runtimeOutput": truncate_text(result["program_error"] or result.get("program_message", ""), 4000),
            }

        try:
            exit_code = int(result["status"])
        except ValueError as error:
            raise RequestError(502, "在线判题服务返回了无效的程序退出状态。") from error
        if exit_code != 0 and compiler_output:
            return {
                "status": "compile_error",
                "message": "编译未通过，请阅读错误信息并修改程序。",
                "compilerOutput": truncate_text(compiler_output, 5000),
            }
        if exit_code != 0:
            return {
                "status": "runtime_error",
                "message": f"程序异常退出（测试 {index}）。",
                "runtimeOutput": truncate_text(result["program_error"] or result.get("program_message", ""), 4000),
            }

        actual_output = truncate_text(result["program_output"], 4000)
        if normalize_output(actual_output) != normalize_output(test["output"]):
            return {
                "status": "wrong_answer",
                "message": f"第 {index} 组测试未通过。",
                "passedTests": index - 1,
                "totalTests": len(tests),
                "expectedOutput": truncate_text(test["output"], 2000),
                "actualOutput": actual_output,
            }

    return {
        "status": "accepted",
        "message": f"全部 {len(tests)} 组测试通过！",
        "passedTests": len(tests),
        "totalTests": len(tests),
    }


def generate_questions(count, courses, variation=""):
    provider = active_provider()
    provider_name = provider["name"]
    api_key = os.environ.get(provider["key_env"], "").strip()
    if not api_key:
        raise RequestError(
            503,
            f"尚未配置{provider_name} API Key。请在服务端环境变量中设置 {provider['key_env']}。",
        )

    system_prompt = (
        "你是严谨的中文 C 语言与 STM32 教学出题老师。"
        "只根据用户提供的课程资料出题，不能引入超出课程范围的知识。"
        "题目适合循序渐进的初学者，表达清晰、条件充分、答案唯一且可验证。"
        "覆盖不同课程主题与难度，避免重复考查同一事实。"
        "每题必须自查题意和标准答案；错误选项应合理但明确错误。"
        "混合生成选择、判断、填空和简短 C 程序题，题型比例尽量均衡。"
        "每种题型至少占总题数的十分之一，且至少 2 道。"
        "判断题选项必须严格为“正确”“错误”。填空题需在题干标出 ____ 空位并给出 accepted 答案列表。"
        "程序题必须是可在标准 GCC 环境独立编译运行的完整 C 程序，只使用标准 C 库，不得包含 STM32 HAL、文件读写或外部依赖；"
        "每个程序题必须有 2 到 5 组 stdin/stdout 测试数据 tests，用来自动编译运行判分。"
        "程序题 solution 必须是完整 C 程序，tests 每项格式为 {\"input\":\"标准输入\",\"output\":\"期望标准输出\"}。"
        "选择/判断题使用 options 和从 0 开始的整数 answer；填空题使用 accepted；程序题使用 solution。"
        "每题必须包含知识点、逐步讲清理由的解析、一个具体易错点。"
        "只输出符合要求的 JSON 对象，不要 Markdown 或额外文字。"
    )
    output_schema = (
        '{"questions":[{"type":"选择题/判断题/填空题/程序题","text":"题干",'
        '"options":["选项A","选项B"],"answer":0,"accepted":["填空标准答案"],"solution":"完整参考 C 程序",'
        '"tests":[{"input":"测试输入","output":"期望输出"},{"input":"边界输入","output":"边界输出"}],'
        '"knowledge":"知识点","explanation":"说明为何答案正确，必要时说明判断过程",'
        '"pitfall":"具体易错点"}]}'
    )
    user_prompt = (
        f"请根据以下课程资料生成恰好 {count} 道互不重复的练习题。"
        "题目应在各课程间合理覆盖，零基础课程要从易到难；"
        "每种题型至少生成总题数的十分之一且不少于 2 道。"
        "尽量平均安排选择、判断、填空和程序题；填空题使用 ____ 标明空位；"
        "程序题应短小、适合初学者，是只依赖标准 C 库的完整可运行程序，读取 stdin 并向 stdout 输出结果；"
        "每题至少给 2 组正确且可核算的测试输入输出。不要出需要 STM32 HAL、硬件、文件或网络的程序题。"
        "如果课程资料没有提供某个事实，不要据常识猜测。"
        f"本轮变化标识：{clean_text(variation, 80)}。可据此调整主题组合与问法，不要重复套用固定题目模板。"
        f"返回 JSON 结构必须为：{output_schema}\n"
        f"课程资料：{json.dumps(courses, ensure_ascii=False)}"
    )
    request_body = json.dumps({
        "model": provider["model"],
        "temperature": 0.6,
        "response_format": {"type": "json_object"},
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
    }).encode("utf-8")

    request = Request(
        provider["url"],
        data=request_body,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urlopen(request, timeout=90) as response:
            provider_response = json.loads(response.read().decode("utf-8"))
    except HTTPError as error:
        error_body = error.read(4000).decode("utf-8", errors="replace")
        try:
            provider_message = json.loads(error_body).get("error", {}).get("message", "")
        except (json.JSONDecodeError, AttributeError):
            provider_message = ""
        if error.code in (401, 403):
            raise RequestError(502, f"{provider_name} API Key 无效或没有访问权限，请检查服务端密钥配置。") from error
        if error.code == 402:
            raise RequestError(502, f"{provider_name} API 账户额度不足或模型不可用。请检查账号额度及模型权限。") from error
        if error.code == 429:
            raise RequestError(502, f"{provider_name} API 请求频率达到限制或服务暂时繁忙，请稍后重试。") from error
        detail = clean_text(provider_message, 240)
        raise RequestError(502, f"{provider_name} API 请求失败（HTTP {error.code}）。{detail}") from error
    except (URLError, TimeoutError) as error:
        raise RequestError(502, f"无法连接{provider_name}服务或请求超时，请检查网络后重试。") from error
    except (json.JSONDecodeError, UnicodeDecodeError) as error:
        raise RequestError(502, f"{provider_name}返回了无法读取的数据，请稍后重试。") from error

    try:
        content = provider_response["choices"][0]["message"]["content"]
        decoded = json.loads(content)
    except (KeyError, IndexError, TypeError, json.JSONDecodeError) as error:
        raise RequestError(502, "AI 返回内容不是预期的 JSON 题目格式，请重试。") from error
    return validate_questions(decoded, count)


class LearningSiteHandler(BaseHTTPRequestHandler):
    def allowed_origin(self):
        origin = self.headers.get("Origin", "").rstrip("/")
        return origin if origin in ALLOWED_ORIGINS else None

    def send_json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        origin = self.allowed_origin()
        if origin:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        if self.path not in ("/api/generate", "/api/run") or not self.allowed_origin():
            self.send_json(403, {"error": "该网站来源不允许访问此服务。"})
            return
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", self.allowed_origin())
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.send_header("Access-Control-Max-Age", "600")
        self.send_header("Vary", "Origin")
        self.end_headers()

    def do_GET(self):
        if self.path == "/api/health":
            self.send_json(200, {
                "ok": True,
                "provider": active_provider()["name"],
                "configured": bool(os.environ.get(active_provider()["key_env"], "").strip()),
                "requiresToken": bool(SITE_API_TOKEN),
            })
            return
        if self.path not in ("/", "/index.html"):
            self.send_error(404)
            return

        try:
            body = (ROOT / "index.html").read_bytes()
        except OSError:
            self.send_error(500, "无法读取学习网站 index.html。")
            return

        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if self.path not in ("/api/generate", "/api/run"):
            self.send_error(404)
            return

        origin = self.allowed_origin()
        if not origin:
            self.send_json(403, {"error": "该网站来源不允许访问此服务。"})
            return
        if SITE_API_TOKEN:
            authorization = self.headers.get("Authorization", "")
            supplied_token = authorization[7:] if authorization.startswith("Bearer ") else ""
            if not hmac.compare_digest(supplied_token, SITE_API_TOKEN):
                self.send_json(401, {"error": "后端访问口令无效，请在 AI 连接设置中检查口令。"})
                return
        elif HOST not in ("127.0.0.1", "localhost", "::1"):
            self.send_json(503, {"error": "公网服务未配置 SITE_API_TOKEN，管理员需先在服务环境变量中设置访问口令。"})
            return
        if self.headers.get_content_type() != "application/json":
            self.send_json(415, {"error": "请求必须使用 application/json 格式。"})
            return

        client = self.client_address[0]
        now = time.monotonic()
        if self.path == "/api/generate":
            limit_map, lock, window, limit, rate_error = request_times, rate_lock, RATE_WINDOW_SECONDS, RATE_LIMIT, "请求太频繁，请稍等一分钟后再生成。"
        else:
            limit_map, lock, window, limit, rate_error = judge_request_times, judge_lock, JUDGE_WINDOW_SECONDS, JUDGE_RATE_LIMIT, "判题请求太频繁，请等一分钟后再试。"
        with lock:
            recent = [when for when in limit_map.get(client, []) if now - when < window]
            if len(recent) >= limit:
                self.send_json(429, {"error": rate_error})
                return
            limit_map[client] = recent + [now]

        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > MAX_BODY_BYTES:
                raise RequestError(413, "请求内容为空或过大。")
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
            if self.path == "/api/generate":
                count, courses = validate_request(payload)
                variation = clean_text(payload.get("variation"), 80) if isinstance(payload, dict) else ""
                questions = generate_questions(count, courses, variation)
                self.send_json(200, {"questions": questions})
            else:
                source, tests = validate_judge_request(payload)
                self.send_json(200, judge_c_program(source, tests))
        except RequestError as error:
            self.send_json(error.status, {"error": str(error)})
        except (ValueError, UnicodeDecodeError, json.JSONDecodeError):
            self.send_json(400, {"error": "请求不是有效的 JSON 数据。"})
        except ConnectionError:
            return
        except Exception:
            self.log_error("Unexpected error while generating challenge questions")
            self.send_json(500, {"error": "服务器发生意外错误，请查看启动服务器的终端日志。"})

    def log_message(self, message, *args):
        if self.path.startswith("/api/"):
            super().log_message(message, *args)


def main():
    provider = active_provider()
    if HOST not in ("127.0.0.1", "localhost", "::1") and len(SITE_API_TOKEN) < 32:
        raise RuntimeError("公网服务必须配置至少 32 个字符的 SITE_API_TOKEN，不能开放未授权的 AI API。")
    server = ThreadingHTTPServer((HOST, PORT), LearningSiteHandler)
    print(f"C 起点学习网站运行中：http://{HOST}:{PORT}/")
    print(f"AI 出题：{provider['name']} · 模型：{provider['model']}")
    print("智谱/DeepSeek Key 状态：" + ("已配置" if os.environ.get(provider["key_env"], "").strip() else "未配置"))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n正在关闭学习网站服务。")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
