import argparse
import os
import sys
import requests
import urllib.request
import logging
import json

from env_token_provider import EnvPrecheckError, build_agent_env_map

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

class AgentClient:
    """
    AISearch ArkClaw Agent 客户端。
    用于将用户的复杂意图发送给本地/远端的 Agent Server 进行规划与执行。
    """

    DEFAULT_URL = "https://knowledge-center.aisearch.volces.com"
    DEFAULT_URL_STG = "https://knowledge-center-stg.aisearch.volces.com"
    DEFAULT_URL_PPE = "https://knowledge-center-ppe.aisearch.volces.com"
    DEFAULT_REGION_URL = "http://100.96.0.96/latest/region_id"
    DEFAULT_OWNER_ACCOUNT_ID_URL = "http://100.96.0.96/latest/owner_account_id"
    ENV_AISEARCH_AGENT_BASE_URL = "AISEARCH_AGENT_BASE_URL"
    ENV_CLAW_PROVIDER = "CLAW_PROVIDER"
    ENV_CLAW_ENV = "CLAW_ENV"
    DEFAULT_CLAW_PROVIDER = "volcengine"
    DEFAULT_CLAW_ENV = "prod"

    def __init__(self):
        self.base_url = self._resolve_base_url()
        self.submit_endpoint = f"{self.base_url}/api/v1/agent/search"
        self.health_endpoint = f"{self.base_url}/health"
        self.context_store_dir = os.path.expanduser("~/.openclaw/runtime/knowledge-center")

    def check_health(self) -> str:
        """
        测试与后台 Agent Server 的网络连通性。
        """
        logger.info(f"Checking Agent Server health at {self.health_endpoint}")
        try:
            resp = requests.get(self.health_endpoint, timeout=5)
            resp.raise_for_status()
            data = resp.json()
            status = data.get("status", "unknown")
            queue_size = (
                data.get("queue_size")
                or data.get("queue_backlog")
                or data.get("pending_tasks")
                or data.get("backlog")
                or 0
            )
            return f"连通性测试成功。服务状态: {status}, 当前队列积压任务数: {queue_size}。"
        except requests.exceptions.RequestException as e:
            logger.error(f"Health check failed: {e}")
            return f"连通性测试失败，无法连接到 Agent 服务: {str(e)}"
        except Exception as e:
            logger.error(f"Unknown error during health check: {e}")
            return f"连通性测试发生未知错误: {str(e)}"
        
    def _resolve_base_url(self) -> str:
        """
        解析最终使用的 Agent Server base_url。

        优先级：
        1. 如果显式设置了环境变量 `AISEARCH_AGENT_BASE_URL`，直接使用该值；
        2. 否则根据 `CLAW_ENV` 判断环境：
           - `ppe` 使用 `DEFAULT_URL_PPE`
           - `prod` 使用 `DEFAULT_URL`
           - 其他环境使用 `DEFAULT_URL_STG`

        说明：
        - `CLAW_PROVIDER` 当前仅作为环境约定保留，暂不参与域名分流；
        - 海外默认场景可传 `CLAW_PROVIDER=byteplus`、`CLAW_ENV=prod`，
          目前仍会命中生产地址选择逻辑。
        """
        explicit_base_url = os.environ.get(self.ENV_AISEARCH_AGENT_BASE_URL, "").strip()
        if explicit_base_url:
            return explicit_base_url

        claw_env = (os.environ.get(self.ENV_CLAW_ENV, self.DEFAULT_CLAW_ENV) or self.DEFAULT_CLAW_ENV).strip().lower()
        if claw_env == "ppe":
            return self.DEFAULT_URL_PPE
        elif claw_env != "prod":
            return self.DEFAULT_URL_STG
        return self.DEFAULT_URL

    def _load_context_summary_from_store(self, session_id: str) -> str:
        """
        从 knowledge-center 插件生成的当前会话 JSON 文件中读取摘要。
        """
        if not session_id:
            return ""
        store_file = os.path.join(self.context_store_dir, f"{session_id}.json")

        try:
            with open(store_file, "r", encoding="utf-8") as f:
                payload = json.load(f)
            rows = payload
            if not isinstance(rows, list):
                return ""

            lines = []
            for item in rows:
                if not isinstance(item, dict):
                    continue
                role = str(item.get("role", "")).strip().lower()
                text = str(item.get("text", "")).strip()
                if role not in ("user", "assistant") or not text:
                    continue
                lines.append(f"{role}: {text}")
            return "\n\n".join(lines)
        except Exception as e:
            logger.warning(f"Failed to load context from store: {e}")
            return ""

    def run_agent_query(self, query: str, session_id: str, timeout: int = 900) -> str:
        """
        向 Agent 同步提交任务并等待结果。

        :param query: 用户原始查询
        :param session_id: 当前会话 ID，用于从 session context store 中读取上下文
        :param timeout: 最大等待时间（秒），由于 Agent 执行耗时较长，建议设置大一些
        :return: Agent 最终返回的总结或错误信息
        """
        context_summary = self._load_context_summary_from_store(session_id)

        logger.info(f"Submitting query to Agent Server: {query}, session_id={session_id}")
        if context_summary:
            logger.info(f"With context summary: {context_summary}")

        try:
            payload = {
                "query": query,
                "session_id": session_id,
            }
            if context_summary:
                payload["context_summary"] = context_summary
            
            # 将收集到的 env_map 塞入 extra_params 传给 Agent Server
            env_map, missing = build_agent_env_map(session_id)

            # 加载 claw region, 并检查是否为空, 请求 bacara 服务时必须传递
            region = self._load_region()
            account = self._load_account_id()
            if not region:
                missing.append("CLAW_REGION")
            if missing:
                raise EnvPrecheckError(
                    f"⚠️ 缺少必需的环境变量: {', '.join(missing)}。"
                    "请重新为用户提供授权链接或为用户提供其他授权方式，确保前置授权已完成或注入环境变量。"
                )

            space_id = os.environ.get("CLAW_SPACE_ID", "")
            instance_id = os.environ.get("CLAW_INSTANCE_ID", "")
            
            payload["extra_params"] = {
                "env_map": env_map,
                "claw_metadata": {
                    "space_id": space_id,
                    "instance_id": instance_id,
                    "union_id": os.environ.get("OPERATOR_UNION_ID", ""), # 保留union_id，兼容旧的Agent
                    "user_id": os.environ.get("OPERATOR_UNION_ID", ""), 
                    "account_id": account,
                    "region": region
                }
            }
                
            headers = {
                "X-Claw-Space-Id": space_id,
                "X-Claw-Instance-Id": instance_id,
                "X-Claw-Region": region,
                "X-Claw-Account-Id": account,
                "Content-Type": "application/json",
            }
                
            submit_resp = requests.post(
                self.submit_endpoint,
                json=payload,
                headers=headers,
                timeout=timeout,
                stream=True
            )
            submit_resp.raise_for_status()

            final_result = ""
            for line in submit_resp.iter_lines():
                if not line:
                    continue
                decoded_line = line.decode('utf-8')
                if decoded_line.startswith("data: "):
                    data_str = decoded_line[6:].strip()
                    if not data_str:
                        continue
                    
                    if data_str.startswith("正在查询中"):
                        logger.info(f"Agent Server status: {data_str}")
                    else:
                        try:
                            data_obj = json.loads(data_str)
                            final_result = data_obj.get("result", "")
                        except json.JSONDecodeError:
                            logger.info(f"Agent Server stream msg: {data_str}")

            if not final_result:
                return "Agent 执行完成，但未能获取到有效结果。"
            return final_result
                
        except requests.exceptions.RequestException as e:
            logger.error(f"Failed to communicate with Agent Server: {e}")
            return f"系统网络错误或任务超时，无法连接到 Agent 服务: {str(e)}"
        except EnvPrecheckError:
            raise
        except Exception as e:
            logger.error(f"Unknown error: {e}")
            return f"执行过程中发生未知错误: {str(e)}"
        
    def _load_region(self, region_url: str = DEFAULT_REGION_URL) -> str:
        return get_metadata_value(region_url)

    def _load_account_id(self, account_url: str = DEFAULT_OWNER_ACCOUNT_ID_URL) -> str:
        return get_metadata_value(account_url)


def get_metadata_value(url: str, *, timeout: int = 10, default: str = "") -> str:
    try:
        with urllib.request.urlopen(url, timeout=timeout) as response:
            value = response.read().decode("utf-8").strip()
            return value or default
    except Exception as e:
        logger.error(f"Failed to fetching metadata from {url}: {e}")
        return default

def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Knowledge Center AISearch Agent CLI"
    )
    parser.add_argument(
        "--action",
        required=True,
        choices=["check_health", "run_agent_query"],
        help="要执行的动作：check_health（连通性测试）/ run_agent_query（提交复杂查询任务）",
    )
    parser.add_argument("--query", default=None, help="用户完整的原始问题或指令（run_agent_query 必填）")
    parser.add_argument("--session-id", default=None, help="当前 OpenClaw 会话 ID（run_agent_query 必填）")
    parser.add_argument("--timeout", type=int, default=900, help="请求超时时间（秒），默认 900")
    return parser


def main() -> int:
    parser = build_arg_parser()
    args = parser.parse_args()

    client = AgentClient()

    if args.action == "check_health":
        result_text = client.check_health()
        print(json.dumps({"success": True, "result": result_text}, ensure_ascii=False))
        return 0

    if args.action == "run_agent_query":
        if not args.query:
            print(json.dumps(
                {"success": False, "message": "缺少参数 --query"},
                ensure_ascii=False,
            ))
            return 1
        if not args.session_id:
            print(json.dumps(
                {"success": False, "message": "缺少参数 --session-id"},
                ensure_ascii=False,
            ))
            return 1
        try:
            result_text = client.run_agent_query(
                query=args.query,
                session_id=args.session_id,
                timeout=args.timeout,
            )
        except EnvPrecheckError as e:
            logger.error(f"Agent query precheck failed: {e}")
            print(json.dumps({"success": False, "message": str(e)}, ensure_ascii=False))
            return 1

        print(json.dumps({"success": True, "result": result_text}, ensure_ascii=False))
        return 0

    print(json.dumps(
        {"success": False, "message": f"不支持的 action: {args.action}"},
        ensure_ascii=False,
    ))
    return 1


if __name__ == "__main__":
    sys.exit(main())
