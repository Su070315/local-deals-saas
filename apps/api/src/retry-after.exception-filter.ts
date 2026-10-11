import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import { Response } from 'express';

type RateLimitResponse = { retryAfterSeconds?: unknown };

@Catch(HttpException)
export class RetryAfterExceptionFilter implements ExceptionFilter {
  catch(exception: HttpException, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const status = exception.getStatus();
    const exceptionResponse = exception.getResponse();
    const body = typeof exceptionResponse === 'string'
      ? { statusCode: status, message: exceptionResponse }
      : exceptionResponse;
    if (status === HttpStatus.TOO_MANY_REQUESTS && body && typeof body === 'object') {
      const retryAfterSeconds = Number((body as RateLimitResponse).retryAfterSeconds);
      if (Number.isInteger(retryAfterSeconds) && retryAfterSeconds > 0) {
        response.setHeader('Retry-After', String(retryAfterSeconds));
      }
    }
    response.status(status).json(body);
  }
}
