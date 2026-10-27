"""The Answer Core's consumers beyond AI Chat.

AppBI has ONE Answer Core (services/data_core/service.ask). AI Chat
(services/chat/orchestrator.py) and the public Dashboard AI Bot (`public_turn`)
are its consumers; each supplies who is asking and what may be read (a data
scope), and the Core decides, reads, verifies and writes the one final answer.
An Agent Flow is an optional add-on the consumer's turn may call for documents
(services/chat/extension.py) - never the engine that answers.
"""
