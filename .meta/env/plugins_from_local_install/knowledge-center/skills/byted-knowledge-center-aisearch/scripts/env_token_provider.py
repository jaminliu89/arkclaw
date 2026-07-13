import json
import logging
import os
import socket
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)

IDENTITY_SOCKET_PATH = "/root/.openclaw/plugins/identity/identity.sock"
FEISHU_OAUTH_PROVIDER = "viking_feishu_oauth_provider"
FEISHU_ENABLE_ENV = "VIKING_AISEARCH_FEISHU_ENABLE"

TARGET_ENVS = [
    "DATABASE_VIKING_APIG_URL",
    "DATABASE_VIKING_APIG_KEY",
    "AISEARCH_DBW_INSTANCE_INFO_LIST",
    "DATABASE_VIKING_COLLECTION",
    FEISHU_ENABLE_ENV,
]

REQUIRED_ENVS = [
    "VE_TIP_TOKEN",
]


class EnvPrecheckError(ValueError):
    """Raised when credentials or required runtime envs are unavailable."""


class FeishuAuthRequiredError(EnvPrecheckError):
    def __init__(self, auth_url: str):
        self.auth_url = auth_url
        super().__init__(
            "需要飞书授权。请将以下授权链接返回给用户，并告知用户完成授权后再继续检索："
            f"{auth_url}"
        )


def load_dotenv_file(dotenv_path: str = "~/.openclaw/.env") -> Dict[str, str]:
    """从 ~/.openclaw/.env 读取键值对，作为 os.environ 的兜底来源"""
    dotenv_map: Dict[str, str] = {}
    resolved_path = os.path.expanduser(dotenv_path)
    if not os.path.isfile(resolved_path):
        return dotenv_map

    try:
        with open(resolved_path, "r", encoding="utf-8") as f:
            for raw_line in f:
                line = raw_line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue

                key, _, value = line.partition("=")
                key = key.strip()
                value = value.strip()
                if (value.startswith('"') and value.endswith('"')) or (
                    value.startswith("'") and value.endswith("'")
                ):
                    value = value[1:-1]
                if key and value:
                    dotenv_map[key] = value
    except Exception as e:
        logger.warning(f"Failed to load dotenv file {resolved_path}: {e}")
    return dotenv_map


def load_config_value(key: str, dotenv_map: Optional[Dict[str, str]] = None) -> str:
    if dotenv_map is None:
        dotenv_map = load_dotenv_file()

    value = dotenv_map.get(key)
    if value is None or not str(value).strip():
        value = os.environ.get(key)
    if value is None:
        return ""
    return str(value).strip()


def is_feishu_enabled(dotenv_map: Optional[Dict[str, str]] = None) -> bool:
    return load_config_value(FEISHU_ENABLE_ENV, dotenv_map).lower() == "true"


def collect_env_map(dotenv_map: Optional[Dict[str, str]] = None) -> Dict[str, str]:
    """优先从 ~/.openclaw/.env 文件读取；若文件中获取不到，则回退到 os.environ"""
    if dotenv_map is None:
        dotenv_map = load_dotenv_file()

    env_map: Dict[str, str] = {}
    for key in TARGET_ENVS:
        value = load_config_value(key, dotenv_map)
        if value:
            env_map[key] = value
    return env_map


def _parse_http_headers(header_bytes: bytes) -> Dict[str, str]:
    headers: Dict[str, str] = {}
    for raw_line in header_bytes.splitlines()[1:]:
        line = raw_line.decode("utf-8", errors="replace")
        if ":" not in line:
            continue
        key, _, value = line.partition(":")
        headers[key.strip().lower()] = value.strip()
    return headers


def _decode_chunked_body(body_bytes: bytes) -> bytes:
    decoded_chunks = []
    offset = 0
    while offset < len(body_bytes):
        line_end = body_bytes.find(b"\r\n", offset)
        if line_end < 0:
            break

        size_line = body_bytes[offset:line_end].split(b";", 1)[0].strip()
        if not size_line:
            break

        chunk_size = int(size_line, 16)
        offset = line_end + 2
        if chunk_size == 0:
            break

        decoded_chunks.append(body_bytes[offset:offset + chunk_size])
        offset += chunk_size + 2
    return b"".join(decoded_chunks)


def _load_json_body(body_bytes: bytes, is_chunked: bool) -> Dict[str, Any]:
    if is_chunked:
        body_bytes = _decode_chunked_body(body_bytes)

    try:
        return json.loads(body_bytes.decode("utf-8"))
    except json.JSONDecodeError:
        # Some identity responses are chunked even when the header is absent or normalized away.
        decoded_body = _decode_chunked_body(body_bytes)
        if decoded_body:
            return json.loads(decoded_body.decode("utf-8"))
        raise


def request_identity_json(
    method: str,
    path: str,
    body: Optional[Dict[str, Any]] = None,
    socket_path: str = IDENTITY_SOCKET_PATH,
) -> Dict[str, Any]:
    body_bytes = b""
    headers = [
        f"{method} {path} HTTP/1.1",
        "Host: localhost",
        "Accept: application/json",
        "Connection: close",
    ]
    if body is not None:
        body_bytes = json.dumps(body, separators=(",", ":")).encode("utf-8")
        headers.extend([
            "Content-Type: application/json",
            f"Content-Length: {len(body_bytes)}",
        ])

    request_bytes = ("\r\n".join(headers) + "\r\n\r\n").encode("utf-8") + body_bytes
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
        sock.settimeout(5)
        sock.connect(socket_path)
        sock.sendall(request_bytes)

        chunks = []
        while True:
            chunk = sock.recv(4096)
            if not chunk:
                break
            chunks.append(chunk)

    raw_resp = b"".join(chunks)
    header_bytes, _, body_bytes = raw_resp.partition(b"\r\n\r\n")
    status_line = header_bytes.splitlines()[0].decode("utf-8", errors="replace")
    if " 200 " not in status_line:
        raise RuntimeError(status_line)

    headers_map = _parse_http_headers(header_bytes)
    is_chunked = "chunked" in headers_map.get("transfer-encoding", "").lower()
    return _load_json_body(body_bytes, is_chunked)


def load_ve_tip_token(session_id: str) -> str:
    """通过 OpenClaw identity unix socket 获取 VE_TIP_TOKEN"""
    try:
        data = request_identity_json(
            "GET",
            "/token",
            {
                "session": session_id  # 接口需要传sessionKey, 我们当前用的session_id实际上就是sessionKey
            },
        )
        tip_token = data.get("tipToken", "")
        if not isinstance(tip_token, str) or not tip_token.strip():
            logger.warning("Identity socket response does not contain tipToken")
            return ""
        return tip_token.strip()
    except Exception as e:
        logger.warning(f"Failed to load VE_TIP_TOKEN from identity socket: {e}")
        return ""


def load_lark_user_access_token() -> str:
    """通过 OpenClaw identity_fetch 获取 LARK_USER_ACCESS_TOKEN"""
    try:
        data = request_identity_json(
            "POST",
            "/tool/identity_fetch",
            {
                "params": {
                    "provider": FEISHU_OAUTH_PROVIDER,
                    "returnValue": True,
                }
            },
        )
        result = data.get("result", {})
        if not isinstance(result, dict):
            raise EnvPrecheckError("identity_fetch response result is invalid")

        if result.get("success") is True:
            token = result.get("value", "")
            if not isinstance(token, str) or not token.strip():
                raise EnvPrecheckError("identity_fetch response does not contain value")
            return token.strip()

        if result.get("state") == "provider_auth_required":
            auth_url = result.get("authUrl", "")
            if isinstance(auth_url, str) and auth_url.strip():
                raise FeishuAuthRequiredError(auth_url.strip())

        state = result.get("state", "unknown")
        detail = result.get("error") or result.get("message") or result.get("hint")
        if isinstance(detail, str) and detail.strip():
            raise EnvPrecheckError(f"identity_fetch failed: state={state}, detail={detail.strip()}")
        raise EnvPrecheckError(f"identity_fetch failed: state={state}")
    except EnvPrecheckError:
        raise
    except Exception as e:
        raise EnvPrecheckError(f"获取 LARK_USER_ACCESS_TOKEN 失败: {e}") from e


def build_agent_env_map(session_id: str) -> Tuple[Dict[str, str], List[str]]:
    dotenv_map = load_dotenv_file()
    env_map = collect_env_map(dotenv_map)

    feishu_enabled = is_feishu_enabled(dotenv_map)
    if feishu_enabled:
        env_map["LARK_USER_ACCESS_TOKEN"] = load_lark_user_access_token()
    else:
        env_map.pop("LARK_USER_ACCESS_TOKEN", None)

    ve_tip_token = load_ve_tip_token(session_id)
    if ve_tip_token:
        env_map["VE_TIP_TOKEN"] = ve_tip_token

    required_envs = list(REQUIRED_ENVS)
    if feishu_enabled:
        required_envs.append("LARK_USER_ACCESS_TOKEN")

    missing = [k for k in required_envs if not env_map.get(k, "").strip()]
    return env_map, missing
