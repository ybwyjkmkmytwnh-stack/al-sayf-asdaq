// رسائل خطأ واضحة بالعربية لحالات الميكروفون/الجهاز/الخادم (تُختبر في node وتُستعمل في الواجهة).
export function describeMediaError(err) {
  const name = err?.name || '';
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      return { code: 'permission-denied', fatal: true, message: 'تم رفض إذن الميكروفون. اسمح بالوصول من أيقونة القفل بجانب عنوان الصفحة ثم أعد المحاولة. يمكنك الاستماع للتسجيل دون ميكروفون.' };
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return { code: 'no-device', fatal: true, message: 'لم يُعثر على ميكروفون. وصّل ميكروفونًا (أو سماعة بميكروفون) ثم أعد المحاولة.' };
    case 'NotReadableError':
    case 'TrackStartError':
      return { code: 'device-busy', fatal: true, message: 'تعذّر فتح الميكروفون: قد يكون مستخدمًا في تطبيق آخر أو معطّلًا في النظام.' };
    case 'OverconstrainedError':
      return { code: 'constraints', fatal: false, message: 'الميكروفون المختار لا يدعم الإعدادات المطلوبة؛ سنحاول بإعدادات أبسط.' };
    case 'SecurityError':
      return { code: 'insecure-context', fatal: true, message: 'الميكروفون يتطلب صفحة آمنة. شغّل الموقع عبر localhost (python3 serve.py) أو HTTPS.' };
    case 'AbortError':
      return { code: 'aborted', fatal: false, message: 'أُلغي فتح الميكروفون. أعد المحاولة.' };
    case 'NotSupportedError':
      return { code: 'not-supported', fatal: true, message: 'لا يتيح هذا المتصفح أو هذا الوضع الوصول إلى الميكروفون (قد يكون وضعًا بلا واجهة أذونات أو صفحة غير آمنة). افتح الموقع في Chrome أو Safari حديث عبر localhost أو HTTPS. يمكنك الاستماع للتسجيل دون ميكروفون.' };
    default:
      return { code: 'unknown', fatal: true, message: `خطأ غير متوقع في الميكروفون${name ? ` (${name})` : ''}: ${err?.message || 'غير معروف'}` };
  }
}

export const DEVICE_MESSAGES = Object.freeze({
  trackEnded: 'انقطع الميكروفون (فُصل أو أُغلق). أُوقف التقييم مؤقتًا؛ وصّله ثم اضغط «استئناف».',
  trackMuted: 'الميكروفون صامت من النظام أو الجهاز. لا تُحتسب هذه الفترة (غير قابلة للقياس).',
  ctxSuspended: 'علّق المتصفح معالجة الصوت (تبويب في الخلفية أو مقاطعة). لا تُحتسب هذه الفترة.',
  digitalSilence: 'الميكروفون يرسل صمتًا رقميًا كاملًا؛ غالبًا مكتوم أو غير موصول. لا تُحتسب هذه الفترة.',
  serverAbsent: 'خادم توليد الفيديو المحلي غير متاح. التدريب لا يتأثر؛ شغّل الخادم لاحقًا إن أردت الفيديو.',
  analysisMismatch: 'ملف التحليل لا يطابق ملف الصوت. لن يبدأ التدريب حتى يُعاد توليد التحليل.',
});

export function describeVideoServerError(err) {
  if (err?.name === 'AbortError') return 'انتهت مهلة الاتصال بخادم الفيديو المحلي.';
  return DEVICE_MESSAGES.serverAbsent;
}
