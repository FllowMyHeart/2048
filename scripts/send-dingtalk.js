// GitHub Actions 定时执行：从 OSS 的 dingtalk-queue/ 目录读取待发消息，调用钉钉 webhook，成功后删除文件
const OSS = require('ali-oss');

const {
  OSS_ACCESS_KEY_ID,
  OSS_ACCESS_KEY_SECRET,
  OSS_REGION = 'oss-cn-hangzhou',
  OSS_BUCKET = 'monitor-jlw-2048',
  DINGTALK_WEBHOOK,
  DINGTALK_KEYWORD = '监控',
  QUEUE_PREFIX = 'dingtalk-queue/'
} = process.env;

const missing = [];
if (!OSS_ACCESS_KEY_ID) missing.push('OSS_ACCESS_KEY_ID');
if (!OSS_ACCESS_KEY_SECRET) missing.push('OSS_ACCESS_KEY_SECRET');
if (!DINGTALK_WEBHOOK) missing.push('DINGTALK_WEBHOOK');
if (missing.length > 0) {
  console.error('❌ 缺少 GitHub Secrets：', missing.join(', '));
  console.error('请去 https://github.com/<你的用户名>/<仓库>/settings/secrets/actions 添加');
  process.exit(1);
}
console.log('✅ 所有 Secrets 已加载');
console.log(`Region: ${OSS_REGION}, Bucket: ${OSS_BUCKET}, Queue: ${QUEUE_PREFIX}`);

const client = new OSS({
  region: OSS_REGION,
  accessKeyId: OSS_ACCESS_KEY_ID,
  accessKeySecret: OSS_ACCESS_KEY_SECRET,
  bucket: OSS_BUCKET,
  secure: true
});

async function listQueue() {
  const result = await client.list({ prefix: QUEUE_PREFIX, 'max-keys': 100 });
  return result.objects || [];
}

async function readMessage(key) {
  const result = await client.get(key);
  const text = result.content.toString('utf-8');
  return JSON.parse(text);
}

async function sendToDingtalk(msg) {
  const text = `### 📹 ${DINGTALK_KEYWORD}片段 #${msg.idx}\n\n` +
    `**时间**：${msg.time}\n\n` +
    `**大小**：${msg.sizeKb} KB\n\n` +
    `[点击查看视频](${msg.videoUrl})\n\n` +
    `\`${msg.videoUrl}\``;
  const payload = {
    msgtype: 'markdown',
    markdown: {
      title: `${DINGTALK_KEYWORD}片段 #${msg.idx}`,
      text
    }
  };
  const res = await fetch(DINGTALK_WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const json = await res.json();
  if (json.errcode !== 0) {
    throw new Error(`钉钉返回错误: ${JSON.stringify(json)}`);
  }
  return json;
}

async function deleteMessage(key) {
  await client.delete(key);
}

async function main() {
  const objects = await listQueue();
  if (objects.length === 0) {
    console.log('队列为空，无消息可发');
    return;
  }
  console.log(`队列中共 ${objects.length} 条消息`);

  // 按时间排序，避免乱序
  objects.sort((a, b) => a.name.localeCompare(b.name));

  let ok = 0, err = 0;
  for (const obj of objects) {
    try {
      const msg = await readMessage(obj.name);
      await sendToDingtalk(msg);
      await deleteMessage(obj.name);
      ok++;
      console.log(`✅ #${msg.idx} 发送成功 → 已删除 ${obj.name}`);
      // 钉钉机器人限频：每分钟最多 20 条，做个保险延迟
      await new Promise(r => setTimeout(r, 200));
    } catch (e) {
      err++;
      console.error(`❌ ${obj.name} 处理失败:`, e.message);
      // 失败不删除，下次重试
    }
  }
  console.log(`\n完成：成功 ${ok} 条，失败 ${err} 条`);
}

main().catch(err => {
  console.error('脚本异常:', err);
  process.exit(1);
});
