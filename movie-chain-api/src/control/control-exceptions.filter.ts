import { type ArgumentsHost, Catch, type ExceptionFilter } from '@nestjs/common';
import { AllExceptionsFilter } from '../common/filters/all-exceptions.filter';

/**
 * The same error model as the API, without the identity-plane security log
 * (the control plane has no identity connection). Composition, not
 * inheritance: a subclass would inherit the parent's @Inject metadata and
 * Nest would try to resolve SecurityEvents here.
 */
@Catch()
export class ControlExceptionsFilter implements ExceptionFilter {
  private readonly inner = new AllExceptionsFilter(null);

  catch(exception: unknown, host: ArgumentsHost): Promise<void> {
    return this.inner.catch(exception, host);
  }
}
