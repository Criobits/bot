const { SlashCommand } = require('@eartharoid/dbf');
const {
	ApplicationCommandOptionType,
	PermissionsBitField,
	MessageFlags,
} = require('discord.js');
const fs = require('fs');
const { join } = require('path');
const Mustache = require('mustache');
const { AttachmentBuilder } = require('discord.js');
const ExtendedEmbedBuilder = require('../../lib/embed');
const { pools } = require('../../lib/threads');

const { transcript: pool } = pools;

module.exports = class TranscriptSlashCommand extends SlashCommand {
	constructor(client, options) {
		const name = 'transcript';
		super(client, {
			...options,
			description: client.i18n.getMessage(null, `commands.slash.${name}.description`),
			descriptionLocalizations: client.i18n.getAllMessages(`commands.slash.${name}.description`),
			dmPermission: false,
			name,
			nameLocalizations: client.i18n.getAllMessages(`commands.slash.${name}.name`),
			options: [
				{
					autocomplete: true,
					name: 'ticket',
					required: true,
					type: ApplicationCommandOptionType.String,
				},
				{
					name: 'member',
					required: false,
					type: ApplicationCommandOptionType.User,
				},
			].map(option => {
				option.descriptionLocalizations = client.i18n.getAllMessages(`commands.slash.${name}.options.${option.name}.description`);
				option.description = option.descriptionLocalizations['en-GB'];
				option.nameLocalizations = client.i18n.getAllMessages(`commands.slash.${name}.options.${option.name}.name`);
				return option;
			}),
		});

		Mustache.escape = text => text; // don't HTML-escape for MD
		this.templateMd = fs.readFileSync(
			join('./user/templates/', this.client.config.templates.transcript + '.mustache'),
			{ encoding: 'utf8' },
		);
		
		// Load HTML template if enabled in config
		if (this.client.config.templates.transcriptHtml !== false) {
			const htmlTemplatePath = join('./user/templates/', 'transcript.html.mustache');
			if (fs.existsSync(htmlTemplatePath)) {
				this.templateHtml = fs.readFileSync(htmlTemplatePath, { encoding: 'utf8' });
			}
		}
	}

	shouldAllowAccess(interaction, ticket) {
		// the creator can always get their ticket, even from outside the guild
		if (ticket.createdById === interaction.user.id) return true; // user not member (DMs)
		// everyone else must be in the guild
		if (interaction.guild?.id !== ticket.guildId) return false;
		// and have authority
		if (interaction.client.supers.includes(interaction.member.id)) return true;
		if (interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) return true;
		if (interaction.member.roles.cache.filter(role => ticket.category.staffRoles.includes(role.id)).size > 0) return true;
		return false;
	}

	async fillTemplate(ticket) {
		/** @type {import("client")} */
		const client = this.client;

		ticket = await pool.queue(w => w(ticket));

		const channelName = ticket.category.channelName
			.replace(/{+\s?(user)?name\s?}+/gi, ticket.createdBy?.username)
			.replace(/{+\s?(nick|display)(name)?\s?}+/gi, ticket.createdBy?.displayName)
			.replace(/{+\s?num(ber)?\s?}+/gi, ticket.number);
		const fileNameMd = `${channelName}.${this.client.config.templates.transcript.split('.').slice(-1)[0]}`;
		const fileNameHtml = `${channelName}.html`;

		// Common template data
		const closedAtFull = function () {
			return new Intl.DateTimeFormat([ticket.guild.locale, 'en-GB'], {
				dateStyle: 'full',
				timeStyle: 'long',
				timeZone: 'Etc/UTC',
			}).format(this.closedAt);
		};
		const createdAtFull = function () {
			return new Intl.DateTimeFormat([ticket.guild.locale, 'en-GB'], {
				dateStyle: 'full',
				timeStyle: 'long',
				timeZone: 'Etc/UTC',
			}).format(this.createdAt);
		};
		const createdAtTimestamp = function () {
			return new Intl.DateTimeFormat([ticket.guild.locale, 'en-GB'], {
				dateStyle: 'short',
				timeStyle: 'long',
				timeZone: 'Etc/UTC',
			}).format(this.createdAt);
		};

		const guildName = client.guilds.cache.get(ticket.guildId)?.name;
		const pinned = ticket.pinnedMessageIds.join(', ');

		// Render MD transcript
		const transcriptMd = Mustache.render(this.templateMd, {
			channelName,
			closedAtFull,
			createdAtFull,
			createdAtTimestamp,
			guildName,
			pinned,
			ticket,
		});

		// Prepare HTML-specific data
		let transcriptHtml = null;
		if (this.templateHtml) {
			// Process messages for HTML (add isImage flag, isPinned, etc.)
			const processedMessages = ticket.archivedMessages.map(message => {
				const processed = { ...message };
				if (processed.content && processed.content.attachments) {
					processed.content.attachments = processed.content.attachments.map(att => {
						const isImage = att.contentType && att.contentType.startsWith('image/');
						return { ...att, isImage };
					});
				}
				// Check if message is pinned
				processed.isPinned = ticket.pinnedMessageIds.includes(message.number);
				return processed;
			});

			// Generate rating stars for feedback
			let ratingStars = [];
			let ratingEmpty = [];
			if (ticket.feedback?.rating) {
				for (let i = 0; i < ticket.feedback.rating; i++) ratingStars.push(true);
				for (let i = ticket.feedback.rating; i < 5; i++) ratingEmpty.push(true);
			}

			const generatedAt = new Intl.DateTimeFormat([ticket.guild.locale, 'en-GB'], {
				dateStyle: 'full',
				timeStyle: 'long',
				timeZone: 'Etc/UTC',
			}).format(new Date());

			// Create a copy of ticket with processed messages for HTML
			const ticketForHtml = {
				...ticket,
				archivedMessages: processedMessages,
			};

			// Use a separate Mustache instance for HTML to enable escaping
			const MustacheHtml = { ...Mustache };
			MustacheHtml.escape = text => {
				if (typeof text !== 'string') return text;
				return text
					.replace(/&/g, '&amp;')
					.replace(/</g, '&lt;')
					.replace(/>/g, '&gt;')
					.replace(/"/g, '&quot;')
					.replace(/'/g, '&#39;');
			};

			transcriptHtml = Mustache.render(this.templateHtml, {
				channelName,
				closedAtFull,
				createdAtFull,
				createdAtTimestamp,
				generatedAt,
				guildName,
				pinned,
				ratingEmpty,
				ratingStars,
				ticket: ticketForHtml,
			});
		}

		return {
			fileNameHtml,
			fileNameMd,
			transcriptHtml,
			transcriptMd,
		};
	}

	/**
	 * @param {import("discord.js").ChatInputCommandInteraction} interaction
	 */
	async run(interaction, ticketId) {
		/** @type {import("client")} */
		const client = this.client;

		await interaction.deferReply({ flags: MessageFlags.Ephemeral });
		ticketId = ticketId || interaction.options.getString('ticket', true);
		const ticket = await client.prisma.ticket.findUnique({
			include: {
				archivedChannels: true,
				archivedMessages: {
					orderBy: { createdAt: 'asc' },
					where: { external: false },
				},
				archivedRoles: true,
				archivedUsers: true,
				category: true,
				claimedBy: true,
				closedBy: true,
				createdBy: true,
				feedback: true,
				guild: true,
				questionAnswers: { include: { question: true } },
			},
			where: interaction.guildId && ticketId.length < 16
				? {
					guildId_number: {
						guildId: interaction.guildId,
						number: parseInt(ticketId),
					},
				}
				: { id: ticketId },
		});

		if (!ticket) throw new Error(`Ticket ${ticketId} does not exist`);

		if (!this.shouldAllowAccess(interaction, ticket)) {
			const settings = await client.prisma.guild.findUnique({ where: { id: interaction.guild.id } });
			const getMessage = client.i18n.getLocale(settings.locale);
			return await interaction.editReply({
				embeds: [
					new ExtendedEmbedBuilder({
						iconURL: interaction.guild.iconURL(),
						text: ticket.guild.footer,
					})
						.setColor(ticket.guild.errorColour)
						.setTitle(getMessage('commands.slash.transcript.not_staff.title'))
						.setDescription(getMessage('commands.slash.transcript.not_staff.description')),
				],
			});
		}

		const {
			fileNameHtml,
			fileNameMd,
			transcriptHtml,
			transcriptMd,
		} = await this.fillTemplate(ticket);
		
		const files = [];
		
		// Add MD transcript
		const attachmentMd = new AttachmentBuilder()
			.setFile(Buffer.from(transcriptMd))
			.setName(fileNameMd);
		files.push(attachmentMd);
		
		// Add HTML transcript if available
		if (transcriptHtml) {
			const attachmentHtml = new AttachmentBuilder()
				.setFile(Buffer.from(transcriptHtml))
				.setName(fileNameHtml);
			files.push(attachmentHtml);
		}

		await interaction.editReply({ files });
		// TODO: add portal link
	}
};
