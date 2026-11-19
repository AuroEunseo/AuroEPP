import React, { useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { apiFetch } from '../api';
import { useConsole } from '../context/ConsoleContext';

/** 3-2. Windows 업데이트 규칙 (KB 차단·허용 규칙 + 업데이트 카탈로그) */
export const KbRulesPage: React.FC = () => {
  const { state, fetchState, showToast } = useConsole();

  // KB 규칙 입력 상태
  const [kbInput, setKbInput] = useState('');
  const [ruleScope, setRuleScope] = useState('*');

  const addGlobalRule = async (action: 'block' | 'allow' | 'none', targetKb?: string) => {
    const kb = (targetKb || kbInput).trim().toUpperCase();
    if (!/^KB\d{5,8}$/.test(kb)) return alert('KB 번호 형식이 올바르지 않습니다 (예: KB5050009)');
    await apiFetch('/rules', { kb, ring: ruleScope, action });
    if (!targetKb) setKbInput('');
    fetchState();
  };

  return (
    <>
      <div className="page-header">
        <div>
          <h2 className="page-title">Windows 업데이트 규칙 (KB 차단 / 허용)</h2>
          <p className="page-desc">
            수집된 Windows 11 업데이트 요약 내역을 검토하고 문제가 우려되는 패치를 선택해 즉시 차단할 수 있습니다.
          </p>
        </div>
        <button
          onClick={async () => {
            await apiFetch('/catalog/sync', {});
            fetchState();
          }}
          className="btn btn-primary"
        >
          <RefreshCw size={13} /> 지금 업데이트 목록 수집
        </button>
      </div>

      <section className="glass-card panel">
        <div className="panel-header">
          <div>
            <h3 className="panel-title">
              수집된 Windows 11 업데이트 및 내용 요약 ({(state.catalog || []).length}건)
            </h3>
            <p className="page-desc">
              사내 PC에 이미 설치되었거나 대기 중인 업데이트, 그리고 Microsoft 최신 배포 패치 내역입니다.
            </p>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>차단 적용 대상:</span>
            <select
              value={ruleScope}
              onChange={(e) => setRuleScope(e.target.value)}
              className="select-dark mono"
            >
              <option value="*">전체 그룹 (*)</option>
              {Object.keys(state.policies).map((r) => (
                <option key={r} value={r}>{r}</option>
              ))}
            </select>
          </div>
        </div>

        <div className="table-wrap" style={{ maxHeight: 380, overflowY: 'auto' }}>
          <table className="data-table">
            <thead>
              <tr>
                <th style={{ width: 110 }}>KB 번호</th>
                <th style={{ width: 135 }}>분류 / 릴리스</th>
                <th>업데이트 명칭 및 핵심 내용 요약</th>
                <th style={{ width: 130 }}>사내 현황</th>
                <th style={{ width: 110, textAlign: 'right' }}>빠른 조치</th>
              </tr>
            </thead>
            <tbody>
              {(state.catalog || []).map((item) => {
                const isBlocked = state.rules.some(
                  (r) => r.kb === item.kb && r.action === 'block' && (r.ring === '*' || r.ring === ruleScope)
                );
                return (
                  <tr key={item.kb} style={{ cursor: 'default' }}>
                    <td className="mono" style={{ fontWeight: 700, color: 'var(--accent-text)' }}>
                      {item.kb}
                    </td>
                    <td>
                      <div style={{ fontWeight: 600, fontSize: 11.5 }}>{item.category}</div>
                      <div className="mono" style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                        {item.release_date}
                      </div>
                    </td>
                    <td>
                      <div style={{ fontWeight: 600, marginBottom: 3 }}>{item.title}</div>
                      <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.45 }}>
                        {item.summary}
                      </div>
                    </td>
                    <td>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                        <span className="badge badge-ok">설치됨 {item.installed_count}대</span>
                        {item.pending_count > 0 && (
                          <span className="badge badge-warn">대기중 {item.pending_count}대</span>
                        )}
                      </div>
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      {isBlocked ? (
                        <span className="badge badge-danger">차단 등록됨</span>
                      ) : (
                        <button
                          onClick={() => addGlobalRule('block', item.kb)}
                          className="btn btn-rose"
                          style={{ padding: '5px 10px', fontSize: 11.5 }}
                        >
                          선택 차단
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
              {(state.catalog || []).length === 0 && (
                <tr>
                  <td colSpan={5} style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)' }}>
                    아직 수집된 업데이트가 없습니다. 우측 상단의 [지금 업데이트 목록 수집] 버튼을 눌러주세요.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="glass-card panel">
        <div className="panel-header">
          <h3 className="panel-title">적용 중인 KB 차단 / 허용 규칙 ({state.rules.length}건)</h3>
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 18 }}>
          <select
            value={ruleScope}
            onChange={(e) => setRuleScope(e.target.value)}
            className="select-dark mono"
          >
            <option value="*">전체 그룹 (*)</option>
            {Object.keys(state.policies).map((r) => (
              <option key={r} value={r}>{r}</option>
            ))}
          </select>
          <input
            value={kbInput}
            onChange={(e) => setKbInput(e.target.value)}
            placeholder="KB 번호 직접 입력 (예: KB5050009)"
            className="input-dark mono"
            style={{ flex: 1, minWidth: 220 }}
          />
          <button onClick={() => addGlobalRule('block')} className="btn btn-rose">
            차단(자동 숨김) 등록
          </button>
          <button onClick={() => addGlobalRule('allow')} className="btn btn-emerald">
            허용 등록
          </button>
        </div>

        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>KB 번호</th>
                <th>적용 범위</th>
                <th>동작 정책</th>
                <th style={{ textAlign: 'right' }}>규칙 해제</th>
              </tr>
            </thead>
            <tbody>
              {state.rules.map((r, idx) => (
                <tr key={idx} style={{ cursor: 'default' }}>
                  <td className="mono" style={{ fontWeight: 700, color: 'var(--accent-text)' }}>{r.kb}</td>
                  <td className="mono">{r.ring === '*' ? '전체 그룹 (*)' : r.ring}</td>
                  <td>
                    <span className={`badge ${r.action === 'block' ? 'badge-danger' : 'badge-ok'}`}>
                      {r.action === 'block' ? '차단 (숨김 처리)' : '허용'}
                    </span>
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <button
                      onClick={() =>
                        apiFetch('/rules', { kb: r.kb, ring: r.ring, action: 'none' }).then(fetchState)
                      }
                      className="btn btn-ghost"
                      style={{ padding: '4px 10px', fontSize: 11.5 }}
                    >
                      삭제
                    </button>
                  </td>
                </tr>
              ))}
              {state.rules.length === 0 && (
                <tr>
                  <td colSpan={4} style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)' }}>
                    등록된 KB 차단·허용 규칙이 없습니다.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
};
