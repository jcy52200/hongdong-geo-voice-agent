import { identifySalesFaq, isExplicitStop, isInitialRefusal } from './sales-script.js';

export interface InitialQuickReplyState {
  firstItemId?: string;
  firstFinalSeen: boolean;
  outputSeen: boolean;
  operatorControlled: boolean;
  finalItems: Set<string>;
}

export function createInitialQuickReplyState(): InitialQuickReplyState {
  return { firstFinalSeen: false, outputSeen: false, operatorControlled: false, finalItems: new Set() };
}

/** Deliberately narrower than semantic handling in the system prompt. */
export function isPureInitialRefusal(text: string): boolean {
  const value = text.replace(/\s/g, '');
  if (!value || value.length > 60 || /[?？]/.test(value) || isExplicitStop(value) || identifySalesFaq(value)) return false;
  if (!isInitialRefusal(value) && !/不太了解|不太清楚|没有了解过|没有听说过/.test(value)) return false;
  // Let the model answer compound requests/questions, corrections, busy callers,
  // and permission/contact information instead of injecting the fixed paragraph.
  if (/吗|么|什么|多少|哪里|哪儿|哪家|哪位|谁|怎么|怎样|如何|为何|为什么|是否|行不行|可不可以|靠不靠谱|可不可靠|好不好|有没有|是不是|能不能|要不要/.test(value)) return false;
  if (/不是不|并非不|没有说不|没说不|不过|但是|只是|但|要不|你先|您先|先说|先讲|说说|讲讲|介绍下|介绍一下|继续|发我|给我|加我|你说|您说|你讲|您讲|说吧|讲吧|等一下|等等|等会|等下|稍后|回头|改天|以后|微信|号码|手机号|找老板|老板不在|同事|不在|找错|打错|机器人|智能|助理|留言/.test(value)) return false;
  if (/拜拜|先这样|不想听了|不方便|有事|正忙|很忙|忙呢|忙死|忙不过来|赶时间|不聊|不说了|不要说|不要讲|不用说了|不用讲了|不要介绍|不用介绍了|不要推销/.test(value)) return false;
  return true;
}

export interface InitialQuickReplyContext {
  enabled: boolean;
  muted: boolean;
  controlPending: boolean;
  replacementPending: boolean;
  toolPending: boolean;
}

/** Consume the first final ASR exactly once, including skipped/empty responses. */
export function consumeInitialQuickReply(state: InitialQuickReplyState, itemId: string, text: string,
  context: InitialQuickReplyContext): { trigger: boolean; reason: string } | undefined {
  if (state.finalItems.has(itemId)) return undefined;
  state.finalItems.add(itemId);
  if (state.firstFinalSeen) return undefined;
  state.firstFinalSeen = true;
  state.firstItemId ??= itemId;
  if (itemId !== state.firstItemId) return { trigger: false, reason: 'out_of_order_asr' };
  if (!context.enabled) return { trigger: false, reason: 'disabled' };
  if (context.muted) return { trigger: false, reason: 'input_muted' };
  if (state.operatorControlled || context.controlPending || context.replacementPending || context.toolPending) return { trigger: false, reason: 'operator_or_tool_control' };
  if (state.outputSeen) return { trigger: false, reason: 'model_output_started' };
  if (!isPureInitialRefusal(text)) return { trigger: false, reason: 'not_pure_initial_refusal' };
  return { trigger: true, reason: 'initial_refusal' };
}
