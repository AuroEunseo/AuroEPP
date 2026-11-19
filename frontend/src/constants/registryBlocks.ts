/** 레지스트리 정책 관리 화면의 정책 블록 정의 (켜기/끄기 시 쓸 레지스트리 값) */
export const WU = 'SOFTWARE\\Policies\\Microsoft\\Windows\\WindowsUpdate';

export interface PolicyBlockDef {
  id: string;
  title: string;
  desc: string;
  path: string;
  name: string;
  type: 'DWORD' | 'SZ';
  enabledValue: number | string;
  disabledValue: number | string;
  hasParam?: 'days' | 'version';
  paramName?: string;
}

export const REGISTRY_BLOCKS: PolicyBlockDef[] = [
  {
    id: 'defer_quality',
    title: '품질(보안) 업데이트 설치 지연',
    desc: '정기 보안 패치 배포 시 지정한 일수만큼 설치를 유예하여 초기 패치 오류로부터 사내 PC를 보호합니다.',
    path: WU,
    name: 'DeferQualityUpdates',
    type: 'DWORD',
    enabledValue: 1,
    disabledValue: 0,
    hasParam: 'days',
    paramName: 'DeferQualityUpdatesPeriodInDays',
  },
  {
    id: 'target_version',
    title: 'Windows 기능 업데이트 버전 고정',
    desc: '상위 메이저 OS 버전으로 자동 업그레이드되는 것을 차단하고 지정된 빌드(예: 25H2)로 고정합니다. 지원 종료된 버전에 고정하면 보안 업데이트를 받지 못합니다.',
    path: WU,
    name: 'TargetReleaseVersion',
    type: 'DWORD',
    enabledValue: 1,
    disabledValue: 0,
    hasParam: 'version',
    paramName: 'TargetReleaseVersionInfo',
  },
  {
    id: 'exclude_drivers',
    title: 'Windows 업데이트를 통한 드라이버 자동 설치 차단',
    desc: '그래픽·네트워크 등 하드웨어 드라이버가 임의로 덮어씌워져 장비 호환성 문제가 생기는 것을 방지합니다.',
    path: WU,
    name: 'ExcludeWUDriversInQualityUpdate',
    type: 'DWORD',
    enabledValue: 1,
    disabledValue: 0,
  },
  {
    id: 'no_auto_reboot',
    title: '사용자 로그인 중 강제 자동 재부팅 방지',
    desc: '업데이트 설치가 완료되더라도 사용자가 작업 중일 때는 PC가 임의로 재부팅되지 않도록 보호합니다.',
    path: WU + '\\AU',
    name: 'NoAutoRebootWithLoggedOnUsers',
    type: 'DWORD',
    enabledValue: 1,
    disabledValue: 0,
  },
  {
    id: 'disable_os_upgrade',
    title: 'Windows 11 업그레이드 제안 및 자동 전환 차단',
    desc: 'Windows 10 환경에서 상위 OS 업그레이드 안내 및 자동 전환 프로세스를 차단합니다.',
    path: WU,
    name: 'DisableOSUpgrade',
    type: 'DWORD',
    enabledValue: 1,
    disabledValue: 0,
  },
  {
    id: 'no_auto_update',
    title: 'Windows 기본 자동 업데이트 스케줄러 비활성화',
    desc: 'OS 자체 스케줄러 대신 중앙 관제 콘솔의 명령과 배포 그룹 일정에 의해서만 업데이트가 수행되도록 통제합니다.',
    path: WU + '\\AU',
    name: 'NoAutoUpdate',
    type: 'DWORD',
    enabledValue: 1,
    disabledValue: 0,
  },
];
