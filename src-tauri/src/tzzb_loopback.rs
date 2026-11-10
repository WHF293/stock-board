//! 投资账本 MCP OAuth 回调回环监听（打包版专用通道）
//!
//! dev 环境的 OAuth 回环回调由 vite 中间件（server/tzzb-mcp-proxy.ts）承担
//! （127.0.0.1:8791/callback）；打包版没有 dev server，前端经本命令在 Rust 侧
//! 临时起监听，等系统浏览器完成授权后把回调 URL（含 code / state）送回。
//!
//! 端口与 redirect_uri 必须与 dev 代理保持一致（上游 AS 的 redirect 白名单
//! 就是 `http://127.0.0.1:8791/callback`，勿改）。

use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

/// 回调回环端口（与 server/tzzb-mcp-proxy.ts 的 REDIRECT_PORT 同源）
const REDIRECT_PORT: u16 = 8791;

/// 单连接读请求头的超时（浏览器 GET 请求极小，5s 足够）
const READ_TIMEOUT: Duration = Duration::from_secs(5);

/// 单连接请求头大小上限
const HEAD_LIMIT: usize = 8192;

/// 起回环监听等待授权回调（一次授权流调用一次，收到 /callback 即返回）
///
/// 非 /callback 路径（探测等）回 `ok` 后继续等；/callback 回成功提示页并结束。
///
/// # 参数
/// - `timeout_ms`：整体等待上限（毫秒；对齐 dev 代理的硬超时 30 分钟），超时 Err
///
/// # 返回
/// 完整回调 URL（`http://127.0.0.1:8791/callback?code=...&state=...`），
/// state 校验与 code 交换在前端完成
#[tauri::command]
pub async fn tzzb_wait_loopback_callback(timeout_ms: u64) -> Result<String, String> {
  let listener = TcpListener::bind(("127.0.0.1", REDIRECT_PORT))
    .await
    .map_err(|error| format!("回调端口 {REDIRECT_PORT} 监听失败（可能被其它进程占用）: {error}"))?;
  let deadline = tokio::time::Instant::now() + Duration::from_millis(timeout_ms);

  loop {
    let accepted = tokio::time::timeout_at(deadline, listener.accept()).await;
    let Ok(Ok((mut stream, _))) = accepted else {
      return Err("等待授权超时".to_string());
    };

    // 读请求头：读到头部结束 / 大小上限 / 读超时为止
    let mut head = Vec::new();
    let mut chunk = [0u8; 1024];
    loop {
      if head.windows(4).any(|window| window == b"\r\n\r\n") || head.len() > HEAD_LIMIT {
        break;
      }
      match tokio::time::timeout(READ_TIMEOUT, stream.read(&mut chunk)).await {
        Ok(Ok(n)) if n > 0 => head.extend_from_slice(&chunk[..n]),
        _ => break,
      }
    }
    let text = String::from_utf8_lossy(&head);
    let request_line = text.lines().next().unwrap_or("");
    let raw_path = request_line.split_whitespace().nth(1).unwrap_or("/");
    let is_callback = raw_path.starts_with("/callback");
    let body = if is_callback {
      "<h2>授权成功</h2>可关闭此窗口，回到股票看板。"
    } else {
      "ok"
    };
    let response = format!(
      "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
      body.len(),
      body
    );
    let _ = stream.write_all(response.as_bytes()).await;
    let _ = stream.flush().await;

    if is_callback {
      return Ok(format!("http://127.0.0.1:{REDIRECT_PORT}{raw_path}"));
    }
  }
}
