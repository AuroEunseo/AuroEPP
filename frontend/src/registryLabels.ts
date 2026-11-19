import { RegistryChange } from './types';

/** 레지스트리 정책 값을 사람이 읽기 쉬운 한국어로 바꾸기 위한 사전 */
interface LabelDef {
  label: string;
  describe?: (v: any) => string;
}

const onOff = (on: string, off: string) => (v: any) => (Number(v) === 1 ? on : Number(v) === 0 ? off : String(v));

export const REGISTRY_LABELS: Record<string, LabelDef> = {
  DeferQualityUpdates: { label: '품질(보안) 업데이트 설치 지연', describe: onOff('사용', '사용 안 함') },
  DeferQualityUpdatesPeriodInDays: { label: '품질 업데이트 지연 일수', describe: (v) => `${v}일` },
  DeferFeatureUpdates: { label: '기능 업데이트 설치 지연', describe: onOff('사용', '사용 안 함') },
  DeferFeatureUpdatesPeriodInDays: { label: '기능 업데이트 지연 일수', describe: (v) => `${v}일` },
  ProductVersion: { label: '고정 대상 제품', describe: (v) => String(v) },
  TargetReleaseVersion: { label: '기능 업데이트 버전 고정', describe: onOff('사용', '사용 안 함') },
  TargetReleaseVersionInfo: { label: '고정 대상 버전', describe: (v) => String(v) },
  ExcludeWUDriversInQualityUpdate: {
    label: 'Windows 업데이트로 드라이버 설치',
    describe: onOff('차단', '허용'),
  },
  NoAutoRebootWithLoggedOnUsers: {
    label: '로그인 중 자동 재부팅',
    describe: onOff('방지', '허용'),
  },
  DisableOSUpgrade: { label: 'OS 업그레이드 제안', describe: onOff('차단', '허용') },
  NoAutoUpdate: { label: 'Windows 자동 업데이트', describe: onOff('끔', '켬') },
  AUOptions: {
    label: '자동 업데이트 동작 방식',
    describe: (v) =>
      ({ 2: '다운로드 전 알림', 3: '자동 다운로드 후 설치 알림', 4: '자동 다운로드 및 예약 설치', 5: '로컬 관리자 선택' } as Record<
        number,
        string
      >)[Number(v)] || String(v),
  },
};

const REG_TYPE_NAMES: Record<number, string> = {
  1: '문자열',
  2: '확장 문자열',
  3: '바이너리',
  4: '숫자(DWORD)',
  7: '다중 문자열',
  11: '숫자(QWORD)',
};

export function registryLabel(name: string): string {
  return REGISTRY_LABELS[name]?.label || name;
}

export function describeValue(name: string, exists: boolean, value: any): string {
  if (!exists) return '설정 없음';
  if (value && typeof value === 'object' && '__hex__' in value) return `바이너리(${String(value.__hex__).length / 2}바이트)`;
  const def = REGISTRY_LABELS[name];
  return def?.describe ? def.describe(value) : String(value);
}

export function regTypeName(t: number | null | undefined): string {
  return t == null ? '-' : REG_TYPE_NAMES[t] || `형식 ${t}`;
}

/** 예) "품질 업데이트 지연 일수: 7일 → 14일" */
export function summarizeChange(c: RegistryChange): string {
  const before = describeValue(c.name, c.old_exists, c.old_value);
  const after = describeValue(c.name, c.new_exists, c.new_value);
  return `${registryLabel(c.name)}: ${before} → ${after}`;
}

/** 롤백하면 어떻게 되는지 안내 문구 */
export function rollbackPreview(c: RegistryChange): string {
  const before = describeValue(c.name, c.old_exists, c.old_value);
  return c.old_exists
    ? `'${registryLabel(c.name)}' 값을 변경 전 값(${before})으로 되돌립니다.`
    : `'${registryLabel(c.name)}' 값을 삭제해 변경 전처럼 '설정 없음' 상태로 되돌립니다.`;
}

export const HISTORY_OP: Record<number, string> = { 1: '설치', 2: '제거', 3: '기타' };
export const HISTORY_RESULT: Record<number, { text: string; cls: string }> = {
  0: { text: '시작 안 됨', cls: 'badge-warn' },
  1: { text: '진행 중', cls: 'badge-warn' },
  2: { text: '성공', cls: 'badge-ok' },
  3: { text: '부분 성공', cls: 'badge-warn' },
  4: { text: '실패', cls: 'badge-danger' },
  5: { text: '중단됨', cls: 'badge-danger' },
};
