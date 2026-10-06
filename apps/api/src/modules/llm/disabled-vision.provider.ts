// A11 (Feature 17): the VISION_PROVIDER=none binding.
//
// Not a no-op and not a null object that returns something plausible: every
// method throws `MediaUnreadable`, whose rescue policy is UNSUPPORTED_MEDIA. An
// operator who has not configured vision gets exactly the pre-Feature-17
// behaviour — the image reaches a human — instead of an agent quietly answering
// a photo it never saw.
import { Injectable } from '@nestjs/common';
import { MediaUnreadable } from '@repo/errors';
import {
  VisionLlmProvider,
  type LlmCompleteResult,
  type LlmToolResult,
} from './ports/llm-provider.port';

const NOT_CONFIGURED =
  'Vision understanding is not configured (VISION_PROVIDER=none).';

@Injectable()
export class DisabledVisionProvider extends VisionLlmProvider {
  complete(): Promise<LlmCompleteResult> {
    return Promise.reject(new MediaUnreadable(NOT_CONFIGURED));
  }

  completeWithTools(): Promise<LlmToolResult> {
    return Promise.reject(new MediaUnreadable(NOT_CONFIGURED));
  }

  countTokens(): Promise<number> {
    return Promise.reject(new MediaUnreadable(NOT_CONFIGURED));
  }

  override supportsVision(): boolean {
    return false;
  }
}
