# Native Chatwoot private notes in a dedicated account and API inbox with no outbound channel.
require 'digest'
require 'json'
payload = JSON.parse(STDIN.read)
rows = payload.fetch('rows')
raise 'invalid batch' unless rows.size.between?(1, 200) && rows.map { |r| [r.fetch('envelope'),r.fetch('id')] }.uniq.size == rows.size
raise 'invalid record' unless rows.all? { |r| /\A[0-9a-f]{64}\z/.match?(r.fetch('envelope')) && r['allowedAutomaticActions'] == 0 && !r['control'] }
account_name = 'JP • Atendimento interno'
inbox_name = 'Revisão privada da manutenção'
identity = 'jp-revisao-interna-manutencao'
result = ActiveRecord::Base.transaction do
  ActiveRecord::Base.connection.execute('SELECT pg_advisory_xact_lock(984731225)')
  account = Account.find_by(name: account_name)
  if account
    inbox = account.inboxes.find_by!(name: inbox_name)
    contact = account.contacts.find_by!(identifier: identity)
    conv = account.conversations.find_by!(inbox: inbox, contact: contact)
  else
    account = Account.create!(name: account_name)
    channel = Channel::Api.create!(account: account)
    inbox = Inbox.create!(account: account, channel: channel, name: inbox_name, enable_auto_assignment: false)
    contact = account.contacts.create!(name: 'Revisão interna da equipe JP', identifier: identity)
    ci = ContactInbox.create!(inbox: inbox, contact: contact, source_id: SecureRandom.uuid)
    conv = Conversation.create!(account: account, inbox: inbox, contact: contact, contact_inbox: ci).reload
  end
  raise 'external destination' unless inbox.channel.is_a?(Channel::Api) && inbox.channel.webhook_url.blank? && account.webhooks.empty?
  raise 'non-internal contact' unless contact.email.blank? && contact.phone_number.blank? && conv.contact_id == contact.id
  written = []
  rows.each do |r|
    reason = {'no_later_outbound_observed'=>'Sem saída posterior observada', 'later_outbound_requires_review'=>'Há saída posterior a conferir'}.fetch(r.fetch('reason'))
    who = r['customer'] ? "Cadastro AppBarber #{r.fetch('customer')}" : 'Identidade a conferir pela equipe'
    excerpt = r['preview'].presence || "Conteúdo #{r.fetch('kind')}. Consultar o original."
    body = "#{reason} • #{r.fetch('at')} (Cuiabá)\n#{who}\nMensagem recebida: #{excerpt}\nID no WhatsApp: #{r.fetch('id')}\nRegistro: #{r.fetch('envelope')}\nRevisão humana. Sem reenvio automático."
    ref = 'jp-maintenance-review/' + r.fetch('envelope') + '/' + Digest::SHA256.hexdigest(r.fetch('id'))
    msg = conv.messages.find_by(source_id: ref)
    if msg
      raise 'existing note mismatch' unless msg.private? && msg.content == body
    else
      msg = conv.messages.create!(account: account, inbox: inbox, private: true, message_type: :outgoing, content: body, source_id: ref)
    end
    raise 'private note failed' unless msg.reload.private? && msg.conversation_id == conv.id
    written << [r.fetch('envelope'), msg.id]
  end
  raise 'unexpected public message' if conv.messages.where(private: false).exists?
  {account: account.id, inbox: inbox.id, conversation: conv.display_id, private_notes: written,
   member_count: inbox.inbox_members.count, contact_has_delivery_address: false, channel_callback: false}
end
puts 'RECEIPT=' + JSON.generate(result)
