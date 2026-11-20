import React, { useEffect, useState } from 'react';
import { SoftwarePackage } from '../../types';
import { PackageIcon } from './PackageIcon';

/** 프로그램 등록/수정 입력값 */
export interface PackageMeta {
  name: string;
  version: string;
  publisher: string;
  install_args: string;
  uninstall_cmd: string;
  detect_name: string;
  timeout_min: number;
  notes: string;
  description: string;
  self_service: boolean;
  self_approval: boolean;
}

/** 아이콘 변경 내용 (저장 시 함께 반영) */
export interface IconChange {
  file: File | null;
  remove: boolean;
}

export const ICON_MAX_KB = 128;

/** EXE 무인 설치 옵션 예시 (설치 프로그램 제작 도구별) */
export const EXE_PRESETS = [
  { label: 'NSIS', args: '/S' },
  { label: 'Electron (모든 사용자)', args: '/S /allusers' },
  { label: 'Inno Setup', args: '/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /SP-' },
  { label: 'InstallShield', args: '/s /v"/qn /norestart"' },
  { label: 'MSI 래퍼·일반', args: '/quiet /norestart' },
];

export function metaFromPackage(p: SoftwarePackage): PackageMeta {
  return {
    name: p.name, version: p.version, publisher: p.publisher, install_args: p.install_args,
    uninstall_cmd: p.uninstall_cmd, detect_name: p.detect_name, timeout_min: p.timeout_min, notes: p.notes,
    description: p.description || '', self_service: !!p.self_service, self_approval: !!p.self_approval,
  };
}

export function metaFromFilename(filename: string): PackageMeta {
  const base = filename.replace(/\.(msi|exe)$/i, '');
  const ver = base.match(/(\d+(?:\.\d+){1,3})/)?.[1] || '';
  const name = base.replace(ver, '').replace(/[-_ ]+(setup|installer|x64|x86|win64|win32)?[-_ ]*$/i, '').replace(/[-_]+/g, ' ').trim() || base;
  return {
    name, version: ver, publisher: '', install_args: '', uninstall_cmd: '', detect_name: name, timeout_min: 30, notes: '',
    description: '', self_service: false, self_approval: false,
  };
}

interface Props {
  kind: 'msi' | 'exe';
  initial: PackageMeta;
  /** 수정 중인 프로그램 (현재 아이콘 표시용, 새 등록이면 없음) */
  pkg?: SoftwarePackage;
  submitLabel: string;
  busy?: boolean;
  onSubmit: (meta: PackageMeta, icon: IconChange) => void;
  onCancel: () => void;
}

const label: React.CSSProperties = { display: 'block', fontSize: 12, marginBottom: 4, color: 'var(--text-secondary)' };
const hint: React.CSSProperties = { fontSize: 11.5, color: 'var(--text-muted)', marginTop: 4, lineHeight: 1.45 };

/** 프로그램 이름·버전·무인 설치 옵션 입력 폼 (등록·수정 공용) */
export const PackageForm: React.FC<Props> = ({ kind, initial, pkg, submitLabel, busy, onSubmit, onCancel }) => {
  const [m, setM] = useState<PackageMeta>(initial);
  const set = (k: keyof PackageMeta, v: string | number | boolean) => setM((prev) => ({ ...prev, [k]: v }));
  const [iconFile, setIconFile] = useState<File | null>(null);
  const [removeIcon, setRemoveIcon] = useState(false);
  const [preview, setPreview] = useState('');

  useEffect(() => {
    if (!iconFile) return setPreview('');
    const url = URL.createObjectURL(iconFile);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [iconFile]);

  const pickIcon = (f?: File) => {
    if (!f) return;
    if (!/\.(png|ico)$/i.test(f.name)) return alert('아이콘은 PNG 또는 ICO 파일만 올릴 수 있습니다.');
    if (f.size > ICON_MAX_KB * 1024) return alert(`아이콘은 ${ICON_MAX_KB}KB 이하만 올릴 수 있습니다.`);
    setIconFile(f);
    setRemoveIcon(false);
  };
  const hasCurrent = !!pkg?.has_icon && !removeIcon;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(m, { file: iconFile, remove: removeIcon && !iconFile });
      }}
      style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}
    >
      <div>
        <label style={label}>프로그램 이름 *</label>
        <input className="input-dark" style={{ width: '100%' }} value={m.name} onChange={(e) => set('name', e.target.value)} />
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <div style={{ flex: 1 }}>
          <label style={label}>버전</label>
          <input className="input-dark" style={{ width: '100%' }} value={m.version} onChange={(e) => set('version', e.target.value)} />
        </div>
        <div style={{ flex: 1 }}>
          <label style={label}>게시자</label>
          <input className="input-dark" style={{ width: '100%' }} value={m.publisher} onChange={(e) => set('publisher', e.target.value)} />
        </div>
      </div>

      <div style={{ gridColumn: '1 / -1' }}>
        <label style={label}>{kind === 'msi' ? '추가 설치 속성 (선택)' : '무인 설치 옵션 *'}</label>
        <input
          className="input-dark mono"
          style={{ width: '100%' }}
          value={m.install_args}
          onChange={(e) => set('install_args', e.target.value)}
          placeholder={kind === 'msi' ? '예: ALLUSERS=1 INSTALLDIR="C:\\Program Files\\App"' : '예: /S'}
        />
        {kind === 'msi' ? (
          <div style={hint}>MSI 는 <span className="mono">msiexec /i 파일 /qn /norestart</span> 로 무인 설치되며, 여기 입력한 속성이 뒤에 붙습니다.</div>
        ) : (
          <div style={{ ...hint, display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
            예시:
            {EXE_PRESETS.map((p) => (
              <button key={p.label} type="button" className="btn btn-ghost" style={{ padding: '2px 8px', fontSize: 11 }} onClick={() => set('install_args', p.args)}>
                {p.label} <span className="mono">{p.args}</span>
              </button>
            ))}
            <div style={{ width: '100%' }}>
              에이전트는 SYSTEM 권한으로 화면 없이 설치하므로, 무인 옵션이 없으면 설치 창이 보이지 않는 곳에서 멈췄다가 제한 시간 후 실패합니다.
            </div>
          </div>
        )}
      </div>

      <div>
        <label style={label}>설치 여부 확인용 이름</label>
        <input className="input-dark" style={{ width: '100%' }} value={m.detect_name} onChange={(e) => set('detect_name', e.target.value)} />
        <div style={hint}>PC의 '프로그램 추가/제거' 목록에서 이 글자가 들어간 항목이 있으면 설치된 것으로 봅니다.</div>
      </div>
      <div>
        <label style={label}>설치 제한 시간 (분)</label>
        <input
          className="input-dark"
          type="number"
          min={1}
          max={240}
          style={{ width: 120 }}
          value={m.timeout_min}
          onChange={(e) => set('timeout_min', parseInt(e.target.value, 10) || 30)}
        />
      </div>

      <div style={{ gridColumn: '1 / -1' }}>
        <label style={label}>삭제 명령 (선택)</label>
        <input
          className="input-dark mono"
          style={{ width: '100%' }}
          value={m.uninstall_cmd}
          onChange={(e) => set('uninstall_cmd', e.target.value)}
          placeholder='비우면 자동 (MSI 제품은 msiexec /x). 예: "C:\Program Files\App\uninstall.exe" /S'
        />
        <div style={hint}>비워 두면 MSI 로 설치된 프로그램은 자동으로 무인 삭제합니다. EXE 프로그램은 무인 삭제 명령을 직접 입력해야 할 수 있습니다.</div>
      </div>

      <div style={{ gridColumn: '1 / -1', borderTop: '1px solid var(--border-subtle)', paddingTop: 12 }}>
        <label style={{ ...label, display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-primary)', fontSize: 13 }}>
          <input type="checkbox" checked={m.self_service} onChange={(e) => set('self_service', e.target.checked)} />
          에이전트 '프로그램 설치 센터'에 공개 (사용자가 직접 설치)
        </label>
        {m.self_service && (
          <div style={{ display: 'flex', gap: 16, fontSize: 12.5, margin: '4px 0 0 24px' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input type="radio" checked={!m.self_approval} onChange={() => set('self_approval', false)} /> 누르면 바로 설치
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input type="radio" checked={m.self_approval} onChange={() => set('self_approval', true)} /> 관리자 승인 후 설치
            </label>
          </div>
        )}
        <div style={hint}>
          모든 승인 PC의 설치 센터에 표시됩니다. 사용자가 누른 설치도 이 화면의 무인 설치 옵션으로 SYSTEM 권한 설치되므로, 모든 사용자용(PC 전체) 옵션이 맞는지 먼저
          확인하세요.
        </div>
      </div>

      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
        <PackageIcon id={pkg?.id ?? 0} name={m.name} hasIcon={hasCurrent} rev={pkg?.icon_rev ?? 0} size={52} previewUrl={preview} />
        <div style={{ flex: 1 }}>
          <label style={label}>아이콘 (PNG·ICO, {ICON_MAX_KB}KB 이하)</label>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <label className="btn btn-ghost" style={{ padding: '4px 10px', fontSize: 11.5, cursor: 'pointer' }}>
              파일 선택
              <input type="file" accept=".png,.ico" style={{ display: 'none' }} onChange={(e) => pickIcon(e.target.files?.[0])} />
            </label>
            {(iconFile || hasCurrent) && (
              <button
                type="button"
                className="btn btn-ghost"
                style={{ padding: '4px 10px', fontSize: 11.5 }}
                onClick={() => {
                  setIconFile(null);
                  setRemoveIcon(true);
                }}
              >
                아이콘 없애기
              </button>
            )}
          </div>
          <div style={hint}>{iconFile ? `선택됨: ${iconFile.name} (저장 시 반영)` : '없으면 이름 첫 글자로 표시합니다.'}</div>
        </div>
      </div>
      <div>
        <label style={label}>설명 (설치 센터에 표시)</label>
        <textarea
          className="textarea-dark"
          rows={2}
          maxLength={500}
          style={{ width: '100%', minHeight: 0, height: 72, resize: 'vertical' }}
          value={m.description}
          onChange={(e) => set('description', e.target.value)}
          placeholder="예: 사내 결재 문서 열람용 뷰어"
        />
      </div>

      <div style={{ gridColumn: '1 / -1' }}>
        <label style={label}>메모 (관리자용)</label>
        <textarea
          className="textarea-dark"
          rows={2}
          style={{ width: '100%', minHeight: 0, height: 60, resize: 'vertical' }}
          value={m.notes} onChange={(e) => set('notes', e.target.value)} />
      </div>

      <div style={{ gridColumn: '1 / -1', display: 'flex', gap: 8 }}>
        <button type="submit" className="btn btn-primary" disabled={busy || !m.name.trim() || (kind === 'exe' && !m.install_args.trim())}>
          {submitLabel}
        </button>
        <button type="button" className="btn btn-ghost" onClick={onCancel}>
          취소
        </button>
      </div>
    </form>
  );
};
