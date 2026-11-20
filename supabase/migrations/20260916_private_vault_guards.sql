-- ============================================================================
-- WISP PRIVATE VAULT — follow-up guard
--
-- Run after 20260916_private_vault.sql. Safe to re-run.
--
-- A conversation in Private Vault is end-to-end encrypted on purpose: that is
-- what stops this database from holding a readable copy of it, and what keeps
-- it out of server-side search, digests and push payloads. Turning encryption
-- back off while it is still in the vault would quietly undo that — the vault
-- would keep asking for authentication on the device while new messages arrived
-- here in plaintext.
--
-- The client already refuses, but the client is not where a rule like this
-- belongs. Move the conversation out of the vault first, deliberately, and then
-- decide about encryption.
-- ============================================================================

create or replace function set_chat_e2ee(p_chat uuid, p_on boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not is_member(p_chat) then raise exception 'not a member'; end if;
  if not p_on and is_vaulted(p_chat) then
    raise exception 'a conversation in Private Vault stays encrypted: move it out of the vault first';
  end if;
  update chats set e2ee = p_on where id = p_chat;
  insert into messages (chat_id, sender_id, kind, body)
  values (p_chat, auth.uid(), 'system',
          case when p_on then 'Encryption enabled for new messages' else 'Encryption disabled' end);
end $$;

grant execute on all functions in schema public to authenticated;
