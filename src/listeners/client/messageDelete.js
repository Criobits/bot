const { Listener } = require('@eartharoid/dbf');
const {
	AuditLogEvent, MessageFlags,
} = require('discord.js');
const { logMessageEvent } = require('../../lib/logging');
const { pools } = require('../../lib/threads');

const { crypto } = pools;

module.exports = class extends Listener {
	constructor(client, options) {
		super(client, {
			...options,
			emitter: client,
			event: 'messageDelete',
		});
	}

	/**
	 * @param {import("discord.js").Message} message
	 */
	async run(message) {
		/** @type {import("client")} */
		const client = this.client;

		if (!message.guild) return;

		const ticket = await client.prisma.ticket.findUnique({
			include: { guild: true },
			where: { id: message.channel.id },
		});
		if (!ticket) return;

		let content = message.cleanContent;

		const logEvent = (await message.guild.fetchAuditLogs({
			limit: 1,
			type: AuditLogEvent.MessageDelete,
		})).entries.first();

		if (ticket.guild.archive) {
			try {
				// Use updateMany to avoid error when record doesn't exist
				const result = await client.prisma.archivedMessage.updateMany({
					data: { deleted: true },
					where: { id: message.id },
				});
				
				if (result.count === 0) {
					client.log.verbose(`Archived message ${message.id} can't be marked as deleted because it doesn't exist`);
				}
				
				const archived = await client.prisma.archivedMessage.findUnique({ where: { id: message.id } });
				if (archived?.content) {
					if (!content) {
						const string = await crypto.queue(w => w.decrypt(archived.content));
						content = JSON.parse(string).content; // won't be cleaned
					}
				}
			} catch (error) {
				client.log.warn('Failed to "delete" archived message', message.id);
				client.log.error(error);
			}
		}

		let {
			executor,
			target,
		} = logEvent ?? {};

		executor ||= undefined;
		if (target?.id !== message.author?.id) executor = undefined;

		if (executor) {
			try {
				executor = await message.guild.members.fetch(executor.id);
			} catch (error) {
				client.log.error(error);
			}
		}

		if (message.author.id !== client.user.id && !message.flags.has(MessageFlags.Ephemeral)) {
			await logMessageEvent(this.client, {
				action: 'delete',
				diff: {
					original: { content },
					updated: { content: '' },
				},
				executor,
				target: message,
				ticket,
			});
		}
	}
};
