# 魔搭创空间 · Docker 类型
# ------------------------------------------------------------
# 演示版只跑解析与受控下载（视频≤720P / 音频 / 封面），不登录、不写盘，
# 因此不需要 qrcode 与 ffmpeg 两个依赖（省掉 64MB），镜像只有 node 基础层那么点。
#
# 平台要求：必须监听 0.0.0.0:7860，且响应头不能出现
# Authorization / X-modelscope-* / X-studio-*（本项目都不使用）。

FROM node:20-slim

WORKDIR /app

ENV NODE_ENV=production \
    STUDIO_DEMO=1 \
    NO_OPEN=1 \
    PORT=7860

# 只需要服务端与前端静态文件；config.json / downloads 一律不带进镜像
COPY server.js ./
COPY public ./public

EXPOSE 7860

CMD ["node", "server.js"]
