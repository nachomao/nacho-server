import type { NextFunction, Request, Response } from "express"
import { ZodError, type ZodSchema } from "zod"

/** 统一成功响应 */
export function ok(res: Response, data: unknown, status = 200) {
  res.status(status).json({ ok: true, data })
}

/** 统一错误响应 */
export function fail(res: Response, message: string, status = 400, extra?: Record<string, unknown>) {
  res.status(status).json({ ok: false, message, ...extra })
}

/** 包装异步路由处理器，自动捕获异常交给错误中间件 */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown> | unknown,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next)
  }
}

/** 使用 zod 校验请求体并返回类型安全的数据；校验失败抛出 HttpError(400) */
export function parseBody<T>(schema: ZodSchema<T>, body: unknown): T {
  try {
    return schema.parse(body)
  } catch (err) {
    if (err instanceof ZodError) {
      throw new HttpError(400, "参数校验失败", { errors: err.issues.map((i) => `${i.path.join(".")}: ${i.message}`) })
    }
    throw err
  }
}

/** 可携带 HTTP 状态码的错误类型 */
export class HttpError extends Error {
  status: number
  extra?: Record<string, unknown>
  constructor(status: number, message: string, extra?: Record<string, unknown>) {
    super(message)
    this.status = status
    this.extra = extra
  }
}
