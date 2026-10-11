import { Form, Input, Select } from 'antd';
import type { ModalKind, Store } from './workspace-model';
import { PASSWORD_POLICY_HELP, validateOptionalPassword, validateRequiredPassword } from './password-policy';

export function StaffEditorFields({ kind, stores, editing }: { kind: ModalKind; stores: Store[]; editing: boolean }) {
  if (kind !== 'staff') return null;
  return <>
    <Form.Item name="id" hidden><Input /></Form.Item>
    <Form.Item name="name" label="员工姓名" rules={[{ required: true }]}><Input /></Form.Item>
    <Form.Item name="email" label="登录账号" rules={[{ required: true, type: 'email' }]}><Input disabled={editing} /></Form.Item>
    <Form.Item
      name="password"
      label={editing ? '重置密码（留空不修改）' : '初始密码'}
      rules={editing ? [{ validator: validateOptionalPassword }] : [{ required: true, message: '请输入初始密码' }, { validator: validateRequiredPassword }]}
      extra={PASSWORD_POLICY_HELP}
    >
      <Input.Password autoComplete="new-password" />
    </Form.Item>
    <Form.Item name="storeIds" label="授权门店" rules={[{ required: true }]}><Select mode="multiple" options={stores.map((store) => ({ value: store.id, label: store.name }))} /></Form.Item>
  </>;
}
