import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Download, Edit3, Package, RefreshCw, ShieldCheck, Trash2, Upload, X } from 'lucide-react';
import { apiFetch, errorMessage, getSessionToken } from '../api';
import { useConsole } from '../context/ConsoleContext';
import { PackageStatusRow, SoftwarePackage } from '../types';
import { PackageForm, PackageMeta, metaFromFilename, metaFromPackage } from '../components/programs/PackageForm';
import { DeploymentBadge, isActiveDeployment } from '../components/programs/DeploymentBadge';

interface UploadResult {
  upload_id: string;
  filename: string;
  size: number;
  sha256: string;
  kind: 'msi' | 'exe';
}

const fmtSize = (n: number) =>
  n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(2)} GB` : n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.ceil(n / 1024)} KB`;
const fmtTs = (ts?: number | null) => (ts ? new Date(ts * 1000).toLocaleString('ko-KR') : '-');

/** 설치 파일 업로드 (진행률 표시를 위해 XMLHttpRequest 사용, 파일 본문을 그대로 전송) */
function uploadFile(file: File, onProgress: (pct: number) => void): Promise<UploadResult> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/packages/upload');
    xhr.setRequestHeader('X-Session-Token', getSessionToken());
    xhr.setRequestHeader('X-File-Name', encodeURIComponent(file.name));
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(Math.round((e.loaded * 100) / e.total));
    xhr.onload = () => {
      let body: any = {};
      try {
        body = JSON.parse(xhr.responseText || '{}');
      } catch {
        /* 무시 */
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(body);
      else reject(new Error(body.detail || `업로드 실패 (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error('네트워크 오류로 업로드하지 못했습니다.'));
    xhr.send(file);
  });
}

type Filter = 'all' | 'installed' | 'missing' | 'active' | 'failed';

/** 프로그램 관리: 사내 공용 프로그램 업로드·목록·PC별 설치/삭제 */
export const ProgramsPage: React.FC = () => {
  const { state, role, showToast, fetchState } = useConsole();
  const isAdmin = role === 'admin';
  const [pkgs, setPkgs] = useState<SoftwarePackage[]>([]);
  const [keyId, setKeyId] = useState('');
  const [error, setError] = useState('');

  // 업로드 → 정보 입력
  const [uploadPct, setUploadPct] = useState<number | null>(null);
  const [uploaded, setUploaded] = useState<UploadResult | null>(null);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState<SoftwarePackage | null>(null);

  // 선택한 프로그램의 PC별 현황
  const [selId, setSelId] = useState<number | null>(null);
  const [rows, setRows] = useState<PackageStatusRow[]>([]);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<Filter>('all');

  const loadList = useCallback(async () => {
    try {
      const r = await apiFetch<{ packages: SoftwarePackage[]; signing_key: string }>('/packages');
      setPkgs(r.packages);
      setKeyId(r.signing_key);
      setError('');
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);

  const loadStatus = useCallback(async () => {
    if (selId == null) return;
    try {
      const r = await apiFetch<{ rows: PackageStatusRow[] }>(`/packages/${selId}/status`);
      setRows(r.rows);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [selId]);

  useEffect(() => {
    loadList();
    const id = window.setInterval(loadList, 10000);
    return () => window.clearInterval(id);
  }, [loadList]);

  // 진행 중인 작업이 있을 때는 3초, 없을 때는 10초마다 현황 갱신
  const anyActive = rows.some((r) => isActiveDeployment(r.deployment));
  useEffect(() => {
    setChecked(new Set());
    setRows([]);
    if (selId == null) return;
    loadStatus();
  }, [selId, loadStatus]);
  useEffect(() => {
    if (selId == null) return;
    const id = window.setInterval(loadStatus, anyActive ? 3000 : 10000);
    return () => window.clearInterval(id);
  }, [selId, anyActive, loadStatus]);

  const selected = pkgs.find((p) => p.id === selId) || null;

  const onPickFile = async (file: File | undefined) => {
    if (!file) return;
    if (!/\.(msi|exe)$/i.test(file.name)) return alert('설치 파일은 .msi 또는 .exe 만 올릴 수 있습니다.');
    setUploaded(null);
    setUploadPct(0);
    try {
      const r = await uploadFile(file, setUploadPct);
      setUploaded(r);
    } catch (e) {
      alert(errorMessage(e));
    } finally {
      setUploadPct(null);
    }
  };

  const createPackage = async (meta: PackageMeta) => {
    if (!uploaded) return;
    setSaving(true);
    try {
      const r = await apiFetch<{ id: number }>('/packages', { upload_id: uploaded.upload_id, ...meta });
      showToast(`✓ '${meta.name}' 프로그램을 등록했습니다.`);
      setUploaded(null);
      await loadList();
      setSelId(r.id);
    } catch (e) {
      alert(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const updatePackage = async (meta: PackageMeta) => {
    if (!editing) return;
    setSaving(true);
    try {
      await apiFetch(`/packages/${editing.id}`, meta, 'PUT');
      showToast('✓ 프로그램 정보를 수정했습니다. (이후 요청부터 적용)');
      setEditing(null);
      loadList();
    } catch (e) {
      alert(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const deletePackage = async (p: SoftwarePackage) => {
    if (!confirm(`'${p.name} ${p.version}' 프로그램을 삭제할까요?\n서버의 설치 파일과 배포 기록이 지워지고, 아직 전달되지 않은 설치 요청도 취소됩니다.\n(이미 PC에 설치된 프로그램은 그대로 남습니다)`)) return;
    try {
      await apiFetch(`/packages/${p.id}`, undefined, 'DELETE');
      if (selId === p.id) setSelId(null);
      showToast('✓ 프로그램을 삭제했습니다.');
      loadList();
    } catch (e) {
      alert(errorMessage(e));
    }
  };

  const deploy = async (action: 'install' | 'uninstall') => {
    if (!selected || !checked.size) return alert('대상 PC를 먼저 체크하세요.');
    const targets = rows.filter((r) => checked.has(r.machine_id));
    const offline = targets.filter((r) => !r.online).length;
    const verb = action === 'install' ? '설치' : '삭제';
    const note = offline ? `\n\n※ 꺼져 있는 ${offline}대는 대기열에 보관했다가 다음 부팅 시 바로 ${verb}합니다.` : '';
    if (!confirm(`'${selected.name} ${selected.version}' 을(를) 선택한 ${targets.length}대 PC에 ${verb}할까요?\n화면 없이 백그라운드로 진행됩니다.${note}`)) return;
    try {
      const r = await apiFetch<{ sent: number; queued: string[]; skipped: string[] }>(`/packages/${selected.id}/deploy`, {
        machine_ids: Array.from(checked),
        action,
      });
      const parts = [`즉시 ${r.sent}대`];
      if (r.queued.length) parts.push(`다음 부팅 시 ${r.queued.length}대`);
      if (r.skipped.length) parts.push(`이미 진행 중이라 제외 ${r.skipped.length}대`);
      showToast(`✓ ${verb} 요청: ${parts.join(' · ')}`);
      setChecked(new Set());
      loadStatus();
      loadList();
      fetchState();
    } catch (e) {
      alert(errorMessage(e));
    }
  };

  const cancel = async (deploymentId: number) => {
    try {
      await apiFetch(`/deployments/${deploymentId}/cancel`, {});
      loadStatus();
    } catch (e) {
      alert(errorMessage(e));
    }
  };

  const visibleRows = useMemo(
    () =>
      rows.filter((r) => {
        if (filter === 'installed') return r.installed;
        if (filter === 'missing') return !r.installed;
        if (filter === 'active') return isActiveDeployment(r.deployment);
        if (filter === 'failed') return r.deployment?.status === 'failed';
        return true;
      }),
    [rows, filter]
  );
  const rings = Object.keys(state.policies);
  const allChecked = visibleRows.length > 0 && visibleRows.every((r) => checked.has(r.machine_id));

  return (
    <>
      <div className="page-header">
        <div>
          <h2 className="page-title">프로그램 관리</h2>
          <p className="page-desc">
            사내 공용 프로그램을 올려 두고, 선택한 PC에 백그라운드로 설치·삭제합니다. 에이전트는 서버 서명을 확인한 명령만 실행하고,
            받은 파일의 SHA-256 이 등록된 파일과 같을 때만 설치합니다.
            {keyId && <span className="mono" style={{ marginLeft: 6, fontSize: 11 }}>(서명 키 {keyId}…)</span>}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={loadList} className="btn btn-ghost">
            <RefreshCw size={13} /> 새로고침
          </button>
          {isAdmin && (
            <label className="btn btn-primary" style={{ cursor: 'pointer' }}>
              <Upload size={14} /> 설치 파일 업로드
              <input type="file" accept=".msi,.exe" style={{ display: 'none' }} onChange={(e) => onPickFile(e.target.files?.[0])} />
            </label>
          )}
        </div>
      </div>

      {error && <div style={{ color: '#f43f5e', fontSize: 12.5, marginBottom: 8 }}>{error}</div>}

      {/* 업로드 진행 / 정보 입력 */}
      {uploadPct !== null && (
        <section className="glass-card panel">
          <div style={{ fontSize: 13, marginBottom: 8 }}>설치 파일 업로드 중... {uploadPct}%</div>
          <div style={{ height: 6, borderRadius: 3, background: 'var(--border-subtle)', overflow: 'hidden' }}>
            <div style={{ width: `${uploadPct}%`, height: '100%', background: 'var(--accent-primary)' }} />
          </div>
        </section>
      )}
      {uploaded && (
        <section className="glass-card panel">
          <div className="panel-header">
            <h3 className="panel-title">
              <Package size={16} style={{ color: 'var(--accent-text)' }} />
              <span>새 프로그램 등록 — {uploaded.filename}</span>
            </h3>
          </div>
          <div className="mono" style={{ fontSize: 11.5, color: 'var(--text-muted)', marginBottom: 12 }}>
            {uploaded.kind.toUpperCase()} · {fmtSize(uploaded.size)} · SHA-256 {uploaded.sha256}
          </div>
          <PackageForm
            kind={uploaded.kind}
            initial={metaFromFilename(uploaded.filename)}
            submitLabel="프로그램 등록"
            busy={saving}
            onSubmit={createPackage}
            onCancel={() => setUploaded(null)}
          />
        </section>
      )}
      {editing && (
        <section className="glass-card panel">
          <div className="panel-header">
            <h3 className="panel-title">
              <Edit3 size={16} style={{ color: 'var(--accent-text)' }} />
              <span>프로그램 정보 수정 — {editing.filename}</span>
            </h3>
          </div>
          <PackageForm
            kind={editing.kind}
            initial={metaFromPackage(editing)}
            submitLabel="수정 저장"
            busy={saving}
            onSubmit={updatePackage}
            onCancel={() => setEditing(null)}
          />
        </section>
      )}

      {/* 프로그램 목록 */}
      <section className="glass-card panel">
        {pkgs.length === 0 ? (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
            <Package size={28} style={{ marginBottom: 8 }} />
            <div>등록된 프로그램이 없습니다.{isAdmin ? ' [설치 파일 업로드]로 추가하세요.' : ' (업로드는 관리자 계정만 가능)'}</div>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>프로그램</th>
                  <th>형식 · 크기</th>
                  <th>무인 옵션</th>
                  <th>설치된 PC</th>
                  <th>진행 중 / 실패</th>
                  <th>등록</th>
                  <th style={{ textAlign: 'right' }}>관리</th>
                </tr>
              </thead>
              <tbody>
                {pkgs.map((p) => (
                  <tr
                    key={p.id}
                    onClick={() => setSelId(p.id === selId ? null : p.id)}
                    style={p.id === selId ? { background: 'var(--bg-subcard)' } : undefined}
                  >
                    <td>
                      <strong>{p.name}</strong> <span style={{ color: 'var(--text-secondary)' }}>{p.version}</span>
                      <div className="mono" style={{ fontSize: 11, color: 'var(--text-muted)' }}>{p.filename}</div>
                    </td>
                    <td className="mono" style={{ fontSize: 12 }}>
                      {p.kind.toUpperCase()} · {fmtSize(p.size)}
                    </td>
                    <td className="mono" style={{ fontSize: 11.5, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={p.install_args}>
                      {p.kind === 'msi' ? `/qn ${p.install_args}` : p.install_args || '-'}
                    </td>
                    <td className="mono">{p.installed_count ?? 0}대</td>
                    <td className="mono">
                      {p.active_count ?? 0} / <span style={{ color: p.failed_count ? '#f43f5e' : undefined }}>{p.failed_count ?? 0}</span>
                    </td>
                    <td style={{ fontSize: 12 }}>
                      {fmtTs(p.created_at)}
                      <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>by {p.created_by}</div>
                    </td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }} onClick={(e) => e.stopPropagation()}>
                      <button className="btn btn-ghost" style={{ padding: '4px 9px', fontSize: 11.5 }} onClick={() => setSelId(p.id)}>
                        <Download size={12} /> 배포
                      </button>{' '}
                      {isAdmin && (
                        <>
                          <button className="btn btn-ghost" style={{ padding: '4px 9px', fontSize: 11.5 }} onClick={() => setEditing(p)}>
                            <Edit3 size={12} /> 수정
                          </button>{' '}
                          <button className="btn btn-rose" style={{ padding: '4px 9px', fontSize: 11.5 }} onClick={() => deletePackage(p)}>
                            <Trash2 size={12} /> 삭제
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* 선택한 프로그램의 PC별 현황 + 설치/삭제 */}
      {selected && (
        <section className="glass-card panel">
          <div className="panel-header">
            <h3 className="panel-title">
              <ShieldCheck size={16} style={{ color: 'var(--accent-text)' }} />
              <span>
                {selected.name} {selected.version} — PC별 현황
              </span>
            </h3>
            <button className="btn btn-ghost" style={{ padding: 6 }} onClick={() => setSelId(null)}>
              <X size={14} />
            </button>
          </div>

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginBottom: 10 }}>
            <select className="select-dark" value={filter} onChange={(e) => setFilter(e.target.value as Filter)}>
              <option value="all">전체 PC ({rows.length})</option>
              <option value="installed">설치됨 ({rows.filter((r) => r.installed).length})</option>
              <option value="missing">미설치 ({rows.filter((r) => !r.installed).length})</option>
              <option value="active">진행 중 ({rows.filter((r) => isActiveDeployment(r.deployment)).length})</option>
              <option value="failed">실패 ({rows.filter((r) => r.deployment?.status === 'failed').length})</option>
            </select>
            <select
              className="select-dark"
              value=""
              onChange={(e) => {
                const ring = e.target.value;
                if (ring) setChecked(new Set(rows.filter((r) => r.ring === ring).map((r) => r.machine_id)));
              }}
            >
              <option value="">배포 그룹 단위로 선택…</option>
              {rings.map((r) => (
                <option key={r} value={r}>
                  {r} ({rows.filter((x) => x.ring === r).length}대)
                </option>
              ))}
            </select>
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
              <button className="btn btn-emerald" disabled={!checked.size} onClick={() => deploy('install')}>
                <Download size={13} /> 선택 PC에 설치 ({checked.size})
              </button>
              <button className="btn btn-rose" disabled={!checked.size} onClick={() => deploy('uninstall')}>
                <Trash2 size={13} /> 선택 PC에서 삭제
              </button>
            </div>
          </div>

          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th style={{ width: 32 }}>
                    <input
                      type="checkbox"
                      checked={allChecked}
                      onChange={(e) => setChecked(e.target.checked ? new Set(visibleRows.map((r) => r.machine_id)) : new Set())}
                    />
                  </th>
                  <th>PC</th>
                  <th>배포 그룹</th>
                  <th>설치 여부</th>
                  <th>최근 요청</th>
                  <th>결과 메시지</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((r) => {
                  const d = r.deployment;
                  return (
                    <tr key={r.machine_id}>
                      <td>
                        <input
                          type="checkbox"
                          checked={checked.has(r.machine_id)}
                          onChange={(e) => {
                            const next = new Set(checked);
                            e.target.checked ? next.add(r.machine_id) : next.delete(r.machine_id);
                            setChecked(next);
                          }}
                        />
                      </td>
                      <td>
                        <span className={`dot ${r.online ? 'dot-online' : 'dot-offline'}`} />
                        <strong>{r.hostname}</strong>
                        <div className="mono" style={{ fontSize: 11, color: 'var(--text-muted)', paddingLeft: 15 }}>{r.ip}</div>
                      </td>
                      <td className="mono">{r.ring}</td>
                      <td>
                        {r.installed ? (
                          <span className="badge badge-ok">설치됨 {r.installed_version}</span>
                        ) : (
                          <span className="badge">미설치</span>
                        )}
                        <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 3 }}>목록 확인 {fmtTs(r.software_ts)}</div>
                      </td>
                      <td>
                        <DeploymentBadge d={d} />
                        {d && <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 3 }}>{fmtTs(d.updated_at)} · {d.requested_by}</div>}
                      </td>
                      <td style={{ fontSize: 12, maxWidth: 320, color: d?.status === 'failed' ? '#f43f5e' : 'var(--text-secondary)' }}>
                        {d?.message}
                        {d?.exit_code != null && <span className="mono"> (종료 코드 {d.exit_code})</span>}
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        {d?.status === 'queued' && (
                          <button className="btn btn-ghost" style={{ padding: '3px 8px', fontSize: 11 }} onClick={() => cancel(d.id)}>
                            <X size={11} /> 대기 취소
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </>
  );
};
