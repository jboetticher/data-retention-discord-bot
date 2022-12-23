import { Client, GatewayIntentBits, Message, Collection, TextChannel, CacheType, ChatInputCommandInteraction, TextBasedChannel } from 'discord.js';
import * as dotenv from 'dotenv';
import * as crypto from 'crypto';
import { RegisterCommands, COMMANDS, OPTIONS } from './RegisterCommands';

// Get data from environment variables
dotenv.config();
export const token = process.env.DISCORD_TOKEN as string;
export const appId = process.env.APPLICATION_ID as string;
export const serverId = process.env.SERVER_ID as string;
const SERVER_ROLE = process.env.SERVER_ROLE as string;
const QUERY_THROTTLE = 1000;
const DELETE_THROTTLE = 1000;

// Create a new client instance
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });
client.login(token);
RegisterCommands();

// On Start
client.once('ready', async () => {
    console.log('Data Terminator ready! Beginning default deletion routines.');

    let deleteInstructions: any | Array<{0: number, 1: string}>;
    try {
        deleteInstructions = JSON.parse(process.env.DEFAULT_DELETION ?? "INVALID JSON");
    }
    catch {
        deleteInstructions = undefined;
    }
    

    if (deleteInstructions != undefined) {
        console.log(deleteInstructions,typeof(deleteInstructions));
        const server = await client.guilds.fetch(serverId);

        for (const instruction of deleteInstructions) {
            try {
                const days = instruction[0];
                const channel = instruction[1];

                const deletingChannel = (await server.channels.fetch(channel));
                if (deletingChannel?.isTextBased()) {
                    const routineRef = addDeleteRoutine(deletingChannel as TextChannel, days);
                    DeleteProcess(deletingChannel as TextChannel, routineRef, false, undefined, days);
                }
            }
            catch(e) { 
                console.log("Error beginning default deletion routine: ", e)
            }
        }
    }
});

// On Interaction (interpret commands)
client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    const { commandName } = interaction;

    // Required role & channel check
    if (!await hasRequiredRole(interaction)) return;
    if (!await inRequiredChannel(interaction)) return;

    // Delete command
    switch (commandName) {
        case COMMANDS.Delete:
        case COMMANDS.IntervalDelete:
            await Delete(interaction, commandName); break;
        case COMMANDS.BatchDelete:
            await BatchDelete(interaction); break;
        case COMMANDS.List:
            await List(interaction); break;
        case COMMANDS.Stop:
            await StopDeletion(interaction); break;
        case COMMANDS.Shutdown:
            await Shutdown(interaction); break;
        case COMMANDS.Spam:
            await SpamEmojis(interaction); break;
    }
});


const DELETE_ROUTINE_INTERVAL_PERIOD = 6 * 60 * 60 * 1000;
const DELETE_ROUTINE_INTERVAL_TEXT = "6 hours";

async function hasRequiredRole(interaction: ChatInputCommandInteraction<CacheType>): Promise<boolean> {
    const member = await interaction.guild?.members.fetch(interaction.user.id);
    const hasRole = member?.roles.cache.some(role => role.id === SERVER_ROLE) ?? false
    if (!hasRole) {
        await interaction.reply({ content: `Sorry! You don't have the right role.`, ephemeral: true });
    }
    return hasRole;
}

async function inRequiredChannel(interaction: ChatInputCommandInteraction<CacheType>): Promise<boolean> {
    const channel = interaction.channelId;
    const requiredChannel = process.env.SERVER_CHANNEL;
    const inChannel = requiredChannel == null || requiredChannel == "0" || requiredChannel == channel;
    if (!inChannel) {
        await interaction.reply({ content: `Sorry! You're not in the right channel.`, ephemeral: true });
    }
    return inChannel;
}

function estDelTime(numMsgs: number): string {
    const seconds = numMsgs * (DELETE_THROTTLE / 1000 + 0.2); // Estimation
    if (seconds < 60) return `~${Math.floor(seconds)}s`;
    else {
        const minutes = seconds / 60;
        if (minutes < 60) return `~${Math.floor(minutes)}m`;
        else {
            const hours = minutes / 60;
            return `~${Math.floor(hours)}h`;
        }
    }
}

/**
 * Begins a delete routine
 * @param commandName delete or intervalDel
 */
async function Delete(interaction: ChatInputCommandInteraction<CacheType>, commandName: string) {

    // Get channel to delete in
    const deletingChannel = interaction.options.getChannel(OPTIONS.Channel);
    const isTextChannel = (tbd: any): tbd is TextChannel => (tbd as TextChannel).messages !== undefined;
    if (!isTextChannel(deletingChannel)) {
        await interaction.reply(`Please insert a text channel!`);
        return;
    }
    const isIntervalDelete = commandName == COMMANDS.IntervalDelete;

    // Ensure that we will delete in the deleting channel
    const routineRef = addDeleteRoutine(deletingChannel, isIntervalDelete ? -1 : interaction.options.getInteger(OPTIONS.Days) ?? 30);
    await interaction.reply(
        `Delete process activated for ${deletingChannel.name}. Will begin deletion every ${DELETE_ROUTINE_INTERVAL_TEXT}. Use ` + '`/list` to see status.');
    console.log(`${routineRef.id}: ${interaction.user.username} started a routine to delete messages in ${deletingChannel.name}`);
    await DeleteProcess(deletingChannel, routineRef, isIntervalDelete, interaction);
}

async function DeleteProcess(deletingChannel: TextChannel, routineRef: DeleteRoutine, isIntervalDelete: boolean, interaction?: ChatInputCommandInteraction<CacheType>, days?: number) {
    while (routineIsActive(routineRef.id)) {
        // Get first message to find the rest
        let msgPtr: Message | undefined;
        try {
            msgPtr = await deletingChannel.messages.fetch({ limit: 1 })
                .then(messagePage => (messagePage.size === 1 ? messagePage.at(0) : undefined));
        }
        catch (error) {
            return await TerminateOnQueryResponse(error);
        }
        if (msgPtr == undefined) {
            // Wait for the interval, there might be more messages afterwards
            await EnterIntervalWaitStatus();
            continue;
        }

        // Create a threshold to filter by
        let olderTimestampThreshold = 0, youngerTimestampThreshold = 0, dayThreshold = 30;
        if (isIntervalDelete) {
            youngerTimestampThreshold = 1000 * (interaction?.options.getInteger(OPTIONS.YoungerBounds) ?? 0);
            olderTimestampThreshold = 1000 * (interaction?.options.getInteger(OPTIONS.OlderBounds) ?? 0);
            if (youngerTimestampThreshold <= olderTimestampThreshold) {
                interaction?.channel?.send(
                    "The younger timestamp must have a higher value than the older timestamp. Try sending the command again with different parameters.");
                return;
            }
        }
        else {
            const dateThreshold = new Date();
            dayThreshold = interaction?.options.getInteger(OPTIONS.Days) ?? days ?? 30;
            dateThreshold.setHours(dateThreshold.getHours() - dayThreshold * 24);
            youngerTimestampThreshold = dateThreshold.valueOf();
        }

        // Build old message collection to hold query responses
        const oldMsgs: Message[] = [];
        const addIfTooOld = (msg: Message) => {
            if (olderTimestampThreshold < msg.createdTimestamp && msg.createdTimestamp < youngerTimestampThreshold)
                oldMsgs.push(msg);
        };
        addIfTooOld(msgPtr);

        // Query until there are no more messages
        console.log(`${routineRef.id}: Starting to query messages in ${deletingChannel.name}`);
        try {
            while (msgPtr != undefined) {
                if (!routineIsActive(routineRef.id)) return;

                routineRef.status = `Querying (${oldMsgs.length})`;

                const msgQuery: Collection<string, Message<boolean>> | undefined =
                    await deletingChannel.messages.fetch({ limit: 100, before: msgPtr.id });
                msgQuery?.forEach(addIfTooOld);

                // Update our message pointer to be last message in page of messages
                if (msgQuery) msgPtr = 0 < msgQuery.size ? msgQuery.at(msgQuery.size - 1) : undefined;
                else msgPtr = undefined;

                // Manual throttle as requested
                await timeout(QUERY_THROTTLE);
            }
        }
        catch (error) {
            return await TerminateOnQueryResponse(error);
        }
        console.log(`${routineRef.id}: Messages found in ${deletingChannel.name}: ${oldMsgs.length}. Starting deletion routine.`);

        // Flip messages because it makes Alberto smile
        oldMsgs.reverse();

        // Delete
        routineRef.status = `Deleting ${estDelTime(oldMsgs.length)} (0/${oldMsgs.length})`;
        let deleteCount = 0;
        for (const m in oldMsgs) {
            if (!routineIsActive(routineRef.id)) return;

            try {
                await deletingChannel.messages.delete(oldMsgs[m]);
                deleteCount++;
                routineRef.status = `Deleting ${estDelTime(oldMsgs.length)} (${deleteCount}/${oldMsgs.length})`;
                routineRef.deleted++;

                // Manual throttle as requested
                await timeout(DELETE_THROTTLE);
            }
            catch (error) {
                if (error instanceof Error && error.toString().includes('Missing Permissions')) {
                    await interaction?.channel?.send(`This bot is missing the permissions to delete in ${deletingChannel.name}. Will skip this deletion round.`);
                    break;
                }

                console.log(`${routineRef.id}: ERROR in ${deletingChannel.name} deletion:`);
                console.log(error);
            }
        }
        console.log(`${routineRef.id}: Deletion routine finished in ${deletingChannel.name}. Deleted ${deleteCount} messages. Entering 'Waiting' state.`);

        // Follow up
        if (isIntervalDelete) {
            activeDeleteRoutines = activeDeleteRoutines.filter(x => x.id != routineRef.id);
            return;
        }
        await EnterIntervalWaitStatus();
    }

    async function EnterIntervalWaitStatus() {
        routineRef.status = 'Waiting';
        routineRef.routines++;
        await timeout(DELETE_ROUTINE_INTERVAL_PERIOD);
    }

    async function TerminateOnQueryResponse(error: any) {
        await interaction?.channel?.send(
            `This bot encountered an error while querying messages in ${deletingChannel?.name}. Terminating this routine. Please look at the logs for more details.`);

        console.log(`${routineRef.id}: ERROR in ${deletingChannel?.name} querying:`);
        console.log(error);

        activeDeleteRoutines = activeDeleteRoutines.filter(x => x.id != routineRef.id);
        return;
    }
}

async function BatchDelete(interaction: ChatInputCommandInteraction<CacheType>) {
    const input = interaction.options.getString(OPTIONS.Batch);
    let deleteInstructions: any | Array<{0: number, 1: string}>;
    try {
        deleteInstructions = JSON.parse(input ?? "INVALID JSON");
    }
    catch {
        await interaction.reply({ content: `Incorrect format!`, ephemeral: true });
        return;
    }
    

    if (deleteInstructions != undefined) {
        console.log(deleteInstructions,typeof(deleteInstructions));
        const server = await client.guilds.fetch(serverId);

        for (const instruction of deleteInstructions) {
            try {
                const days = instruction[0];
                const channel = instruction[1];

                const deletingChannel = (await server.channels.fetch(channel));
                if (deletingChannel?.isTextBased()) {
                    const routineRef = addDeleteRoutine(deletingChannel as TextChannel, days);
                    DeleteProcess(deletingChannel as TextChannel, routineRef, false, undefined, days);
                }
            }
            catch(e) { 
                console.log("Error creating batch deletion routine: ", e)
            }
        }
    }

    if(input?.length != undefined && input?.length > 1000) {
        await interaction.reply(`Batch function created using input: ${input.substring(0, 800)}...`);
    }
    else {
        await interaction.reply(`Batch function created using input: ${input}`);
    }
}

type DeleteRoutine = {
    id: string,
    channelId: string,
    days: number,
    status: string,
    deleted: number,
    routines: number
}
let activeDeleteRoutines: DeleteRoutine[] = [];
const routineIsActive = (routineId: string) => activeDeleteRoutines.some(r => r.id == routineId);
const timeout = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function addDeleteRoutine(deletingChannel: TextChannel, days: number): DeleteRoutine {
    const routine: DeleteRoutine = {
        id: crypto.randomUUID(),
        channelId: deletingChannel.id,
        days,
        status: 'Querying',
        deleted: 0,
        routines: 0
    };
    activeDeleteRoutines.push(routine);
    return routine;
}

/**
 * Shuts down the instance of the discord client.
 */
async function Shutdown(interaction: ChatInputCommandInteraction<CacheType>) {
    if (!await hasRequiredRole(interaction)) return;

    await interaction.reply("Shutting down...");
    client.destroy();
    process.exit(0);
}


/**
 * Signals a deletion routine to stop.
 */
async function StopDeletion(interaction: ChatInputCommandInteraction<CacheType>) {
    if (!await hasRequiredRole(interaction)) return;

    const deletingChannel = interaction.options.getChannel(OPTIONS.Channel);
    const channelId = deletingChannel?.id ?? "";
    const removedRoutines = activeDeleteRoutines.filter(x => x.channelId != channelId);
    const numRemoved = activeDeleteRoutines.length - removedRoutines.length;
    activeDeleteRoutines = removedRoutines;

    await interaction.reply(`Halting ${numRemoved} message deletion routines in ${deletingChannel?.name}.`);
}

/**
 * Spams emojis in the channel that the command is sent in. Appx. 1-2 per second.
 */
async function SpamEmojis(interaction: ChatInputCommandInteraction<CacheType>) {
    if (!await hasRequiredRole(interaction)) return;

    await interaction.reply("🤡");
    for (let i = 0; i < 5000; i++) {
        const emojis = ['😀', '😃', '😄', '😁', '😆', '😅', '🤣', '😂', '🙂', '🙃', '🫠', '😉', '😊', '😇', '🥰', '😍', '🤩', '😘', '😗', '☺', '😚', '😙', '🥲', '😋', '😛', '😜', '🤪', '😝', '🤑', '🤗', '🤭', '🫢', '🫣', '🤫', '🤔', '🫡', '🤐', '🤨', '😐', '😑', '😶', '🫥', '😶‍🌫️', '😏', '😒', '🙄', '😬', '😮‍💨', '🤥', '😌', '😔', '😪', '🤤', '😴', '😷', '🤒', '🤕', '🤢', '🤮', '🤧', '🥵', '🥶', '🥴', '😵', '😵‍💫', '🤯', '🤠', '🥳', '🥸', '😎', '🤓', '🧐', '😕', '🫤', '😟', '🙁', '☹', '😮', '😯', '😲', '😳', '🥺', '🥹', '😦', '😧', '😨', '😰', '😥', '😢', '😭', '😱', '😖', '😣', '😞', '😓', '😩', '😫', '🥱', '😤', '😡', '😠', '🤬', '😈', '👿', '💀', '☠', '💩', '🤡', '👹', '👺', '👻', '👽', '👾', '🤖', '😺', '😸', '😹', '😻', '😼', '😽', '🙀', '😿', '😾', '🙈', '🙉', '🙊', '💋', '💌', '💘', '💝', '💖', '💗', '💓', '💞', '💕', '💟', '❣', '💔', '❤️‍🔥', '❤️‍🩹', '❤', '🧡', '💛', '💚', '💙', '💜', '🤎', '🖤', '🤍', '💯', '💢', '💥', '💫', '💦', '💨', '🕳', '💣', '💬', '👁️‍🗨️', '🗨', '🗯', '💭', '💤', '👋', '🤚', '🖐', '✋', '🖖', '🫱', '🫲', '🫳', '🫴', '👌', '🤌', '🤏', '✌', '🤞', '🫰', '🤟', '🤘', '🤙', '👈', '👉', '👆', '🖕', '👇', '☝', '🫵', '👍', '👎', '✊', '👊', '🤛', '🤜', '👏', '🙌', '🫶', '👐', '🤲', '🤝', '🙏', '✍', '💅', '🤳', '💪', '🦾', '🦿', '🦵', '🦶', '👂', '🦻', '👃', '🧠', '🫀', '🫁', '🦷', '🦴', '👀', '👁', '👅', '👄', '🫦', '👶', '🧒', '👦', '👧', '🧑', '👱', '👨', '🧔', '🧔‍♂️', '🧔‍♀️', '👨‍🦰', '👨‍🦱', '👨‍🦳', '👨‍🦲', '👩', '👩‍🦰', '🧑‍🦰', '👩‍🦱', '🧑‍🦱', '👩‍🦳', '🧑‍🦳', '👩‍🦲', '🧑‍🦲', '👱‍♀️', '👱‍♂️', '🧓', '👴', '👵', '🙍', '🙍‍♂️', '🙍‍♀️', '🙎', '🙎‍♂️', '🙎‍♀️', '🙅', '🙅‍♂️', '🙅‍♀️', '🙆', '🙆‍♂️', '🙆‍♀️', '💁', '💁‍♂️', '💁‍♀️', '🙋', '🙋‍♂️', '🙋‍♀️', '🧏', '🧏‍♂️', '🧏‍♀️', '🙇', '🙇‍♂️', '🙇‍♀️', '🤦', '🤦‍♂️', '🤦‍♀️', '🤷', '🤷‍♂️', '🤷‍♀️', '🧑‍⚕️', '👨‍⚕️', '👩‍⚕️', '🧑‍🎓', '👨‍🎓', '👩‍🎓', '🧑‍🏫', '👨‍🏫', '👩‍🏫', '🧑‍⚖️', '👨‍⚖️', '👩‍⚖️', '🧑‍🌾', '👨‍🌾', '👩‍🌾', '🧑‍🍳', '👨‍🍳', '👩‍🍳', '🧑‍🔧', '👨‍🔧', '👩‍🔧', '🧑‍🏭', '👨‍🏭', '👩‍🏭', '🧑‍💼', '👨‍💼', '👩‍💼', '🧑‍🔬', '👨‍🔬', '👩‍🔬', '🧑‍💻', '👨‍💻', '👩‍💻', '🧑‍🎤', '👨‍🎤', '👩‍🎤', '🧑‍🎨', '👨‍🎨', '👩‍🎨', '🧑‍✈️', '👨‍✈️', '👩‍✈️', '🧑‍🚀', '👨‍🚀', '👩‍🚀', '🧑‍🚒', '👨‍🚒', '👩‍🚒', '👮', '👮‍♂️', '👮‍♀️', '🕵', '🕵️‍♂️', '🕵️‍♀️', '💂', '💂‍♂️', '💂‍♀️', '🥷', '👷', '👷‍♂️', '👷‍♀️', '🫅', '🤴', '👸', '👳', '👳‍♂️', '👳‍♀️', '👲', '🧕', '🤵', '🤵‍♂️', '🤵‍♀️', '👰', '👰‍♂️', '👰‍♀️', '🤰', '🫃', '🫄', '🤱', '👩‍🍼', '👨‍🍼', '🧑‍🍼', '👼', '🎅', '🤶', '🧑‍🎄', '🦸', '🦸‍♂️', '🦸‍♀️', '🦹', '🦹‍♂️', '🦹‍♀️', '🧙', '🧙‍♂️', '🧙‍♀️', '🧚', '🧚‍♂️', '🧚‍♀️', '🧛', '🧛‍♂️', '🧛‍♀️', '🧜', '🧜‍♂️', '🧜‍♀️', '🧝', '🧝‍♂️', '🧝‍♀️', '🧞', '🧞‍♂️', '🧞‍♀️', '🧟', '🧟‍♂️', '🧟‍♀️', '🧌', '💆', '💆‍♂️', '💆‍♀️', '💇', '💇‍♂️', '💇‍♀️', '🚶', '🚶‍♂️', '🚶‍♀️', '🧍', '🧍‍♂️', '🧍‍♀️', '🧎', '🧎‍♂️', '🧎‍♀️', '🧑‍🦯', '👨‍🦯', '👩‍🦯', '🧑‍🦼', '👨‍🦼', '👩‍🦼', '🧑‍🦽', '👨‍🦽', '👩‍🦽', '🏃', '🏃‍♂️', '🏃‍♀️', '💃', '🕺', '🕴', '👯', '👯‍♂️', '👯‍♀️', '🧖', '🧖‍♂️', '🧖‍♀️', '🧗', '🧗‍♂️', '🧗‍♀️', '🤺', '🏇', '⛷', '🏂', '🏌', '🏌️‍♂️', '🏌️‍♀️', '🏄', '🏄‍♂️', '🏄‍♀️', '🚣', '🚣‍♂️', '🚣‍♀️', '🏊', '🏊‍♂️', '🏊‍♀️', '⛹', '⛹️‍♂️', '⛹️‍♀️', '🏋', '🏋️‍♂️', '🏋️‍♀️', '🚴', '🚴‍♂️', '🚴‍♀️', '🚵', '🚵‍♂️', '🚵‍♀️', '🤸', '🤸‍♂️', '🤸‍♀️', '🤼', '🤼‍♂️', '🤼‍♀️', '🤽', '🤽‍♂️', '🤽‍♀️', '🤾', '🤾‍♂️', '🤾‍♀️', '🤹', '🤹‍♂️', '🤹‍♀️', '🧘', '🧘‍♂️', '🧘‍♀️', '🛀', '🛌', '🧑‍🤝‍🧑', '👭', '👫', '👬', '💏', '👩‍❤️‍💋‍👨', '👨‍❤️‍💋‍👨', '👩‍❤️‍💋‍👩', '💑', '👩‍❤️‍👨', '👨‍❤️‍👨', '👩‍❤️‍👩', '👪', '👨‍👩‍👦', '👨‍👩‍👧', '👨‍👩‍👧‍👦', '👨‍👩‍👦‍👦', '👨‍👩‍👧‍👧', '👨‍👨‍👦', '👨‍👨‍👧', '👨‍👨‍👧‍👦', '👨‍👨‍👦‍👦', '👨‍👨‍👧‍👧', '👩‍👩‍👦', '👩‍👩‍👧', '👩‍👩‍👧‍👦', '👩‍👩‍👦‍👦', '👩‍👩‍👧‍👧', '👨‍👦', '👨‍👦‍👦', '👨‍👧', '👨‍👧‍👦', '👨‍👧‍👧', '👩‍👦', '👩‍👦‍👦', '👩‍👧', '👩‍👧‍👦', '👩‍👧‍👧', '🗣', '👤', '👥', '🫂', '👣', '🦰', '🦱', '🦳', '🦲', '🐵', '🐒', '🦍', '🦧', '🐶', '🐕', '🦮', '🐕‍🦺', '🐩', '🐺', '🦊', '🦝', '🐱', '🐈', '🐈‍⬛', '🦁', '🐯', '🐅', '🐆', '🐴', '🐎', '🦄', '🦓', '🦌', '🦬', '🐮', '🐂', '🐃', '🐄', '🐷', '🐖', '🐗', '🐽', '🐏', '🐑', '🐐', '🐪', '🐫', '🦙', '🦒', '🐘', '🦣', '🦏', '🦛', '🐭', '🐁', '🐀', '🐹', '🐰', '🐇', '🐿', '🦫', '🦔', '🦇', '🐻', '🐻‍❄️', '🐨', '🐼', '🦥', '🦦', '🦨', '🦘', '🦡', '🐾', '🦃', '🐔', '🐓', '🐣', '🐤', '🐥', '🐦', '🐧', '🕊', '🦅', '🦆', '🦢', '🦉', '🦤', '🪶', '🦩', '🦚', '🦜', '🐸', '🐊', '🐢', '🦎', '🐍', '🐲', '🐉', '🦕', '🦖', '🐳', '🐋', '🐬', '🦭', '🐟', '🐠', '🐡', '🦈', '🐙', '🐚', '🪸', '🐌', '🦋', '🐛', '🐜', '🐝', '🪲', '🐞', '🦗', '🪳', '🕷', '🕸', '🦂', '🦟', '🪰', '🪱', '🦠', '💐', '🌸', '💮', '🪷', '🏵', '🌹', '🥀', '🌺', '🌻', '🌼', '🌷', '🌱', '🪴', '🌲', '🌳', '🌴', '🌵', '🌾', '🌿', '☘', '🍀', '🍁', '🍂', '🍃', '🪹', '🪺', '🍇', '🍈', '🍉', '🍊', '🍋', '🍌', '🍍', '🥭', '🍎', '🍏', '🍐', '🍑', '🍒', '🍓', '🫐', '🥝', '🍅', '🫒', '🥥', '🥑', '🍆', '🥔', '🥕', '🌽', '🌶', '🫑', '🥒', '🥬', '🥦', '🧄', '🧅', '🍄', '🥜', '🫘', '🌰', '🍞', '🥐', '🥖', '🫓', '🥨', '🥯', '🥞', '🧇', '🧀', '🍖', '🍗', '🥩', '🥓', '🍔', '🍟', '🍕', '🌭', '🥪', '🌮', '🌯', '🫔', '🥙', '🧆', '🥚', '🍳', '🥘', '🍲', '🫕', '🥣', '🥗', '🍿', '🧈', '🧂', '🥫', '🍱', '🍘', '🍙', '🍚', '🍛', '🍜', '🍝', '🍠', '🍢', '🍣', '🍤', '🍥', '🥮', '🍡', '🥟', '🥠', '🥡', '🦀', '🦞', '🦐', '🦑', '🦪', '🍦', '🍧', '🍨', '🍩', '🍪', '🎂', '🍰', '🧁', '🥧', '🍫', '🍬', '🍭', '🍮', '🍯', '🍼', '🥛', '☕', '🫖', '🍵', '🍶', '🍾', '🍷', '🍸', '🍹', '🍺', '🍻', '🥂', '🥃', '🫗', '🥤', '🧋', '🧃', '🧉', '🧊', '🥢', '🍽', '🍴', '🥄', '🔪', '🫙', '🏺', '🌍', '🌎', '🌏', '🌐', '🗺', '🗾', '🧭', '🏔', '⛰', '🌋', '🗻', '🏕', '🏖', '🏜', '🏝', '🏞', '🏟', '🏛', '🏗', '🧱', '🪨', '🪵', '🛖', '🏘', '🏚', '🏠', '🏡', '🏢', '🏣', '🏤', '🏥', '🏦', '🏨', '🏩', '🏪', '🏫', '🏬', '🏭', '🏯', '🏰', '💒', '🗼', '🗽', '⛪', '🕌', '🛕', '🕍', '⛩', '🕋', '⛲', '⛺', '🌁', '🌃', '🏙', '🌄', '🌅', '🌆', '🌇', '🌉', '♨', '🎠', '🛝', '🎡', '🎢', '💈', '🎪', '🚂', '🚃', '🚄', '🚅', '🚆', '🚇', '🚈', '🚉', '🚊', '🚝', '🚞', '🚋', '🚌', '🚍', '🚎', '🚐', '🚑', '🚒', '🚓', '🚔', '🚕', '🚖', '🚗', '🚘', '🚙', '🛻', '🚚', '🚛', '🚜', '🏎', '🏍', '🛵', '🦽', '🦼', '🛺', '🚲', '🛴', '🛹', '🛼', '🚏', '🛣', '🛤', '🛢', '⛽', '🛞', '🚨', '🚥', '🚦', '🛑', '🚧', '⚓', '🛟', '⛵', '🛶', '🚤', '🛳', '⛴', '🛥', '🚢', '✈', '🛩', '🛫', '🛬', '🪂', '💺', '🚁', '🚟', '🚠', '🚡', '🛰', '🚀', '🛸', '🛎', '🧳', '⌛', '⏳', '⌚', '⏰', '⏱', '⏲', '🕰', '🕛', '🕧', '🕐', '🕜', '🕑', '🕝', '🕒', '🕞', '🕓', '🕟', '🕔', '🕠', '🕕', '🕡', '🕖', '🕢', '🕗', '🕣', '🕘', '🕤', '🕙', '🕥', '🕚', '🕦', '🌑', '🌒', '🌓', '🌔', '🌕', '🌖', '🌗', '🌘', '🌙', '🌚', '🌛', '🌜', '🌡', '☀', '🌝', '🌞', '🪐', '⭐', '🌟', '🌠', '🌌', '☁', '⛅', '⛈', '🌤', '🌥', '🌦', '🌧', '🌨', '🌩', '🌪', '🌫', '🌬', '🌀', '🌈', '🌂', '☂', '☔', '⛱', '⚡', '❄', '☃', '⛄', '☄', '🔥', '💧', '🌊', '🎃', '🎄', '🎆', '🎇', '🧨', '✨', '🎈', '🎉', '🎊', '🎋', '🎍', '🎎', '🎏', '🎐', '🎑', '🧧', '🎀', '🎁', '🎗', '🎟', '🎫', '🎖', '🏆', '🏅', '🥇', '🥈', '🥉', '⚽', '⚾', '🥎', '🏀', '🏐', '🏈', '🏉', '🎾', '🥏', '🎳', '🏏', '🏑', '🏒', '🥍', '🏓', '🏸', '🥊', '🥋', '🥅', '⛳', '⛸', '🎣', '🤿', '🎽', '🎿', '🛷', '🥌', '🎯', '🪀', '🪁', '🎱', '🔮', '🪄', '🧿', '🪬', '🎮', '🕹', '🎰', '🎲', '🧩', '🧸', '🪅', '🪩', '🪆', '♠', '♥', '♦', '♣', '♟', '🃏', '🀄', '🎴', '🎭', '🖼', '🎨', '🧵', '🪡', '🧶', '🪢', '👓', '🕶', '🥽', '🥼', '🦺', '👔', '👕', '👖', '🧣', '🧤', '🧥', '🧦', '👗', '👘', '🥻', '🩱', '🩲', '🩳', '👙', '👚', '👛', '👜', '👝', '🛍', '🎒', '🩴', '👞', '👟', '🥾', '🥿', '👠', '👡', '🩰', '👢', '👑', '👒', '🎩', '🎓', '🧢', '🪖', '⛑', '📿', '💄', '💍', '💎', '🔇', '🔈', '🔉', '🔊', '📢', '📣', '📯', '🔔', '🔕', '🎼', '🎵', '🎶', '🎙', '🎚', '🎛', '🎤', '🎧', '📻', '🎷', '🪗', '🎸', '🎹', '🎺', '🎻', '🪕', '🥁', '🪘', '📱', '📲', '☎', '📞', '📟', '📠', '🔋', '🪫', '🔌', '💻', '🖥', '🖨', '⌨', '🖱', '🖲', '💽', '💾', '💿', '📀', '🧮', '🎥', '🎞', '📽', '🎬', '📺', '📷', '📸', '📹', '📼', '🔍', '🔎', '🕯', '💡', '🔦', '🏮', '🪔', '📔', '📕', '📖', '📗', '📘', '📙', '📚', '📓', '📒', '📃', '📜', '📄', '📰', '🗞', '📑', '🔖', '🏷', '💰', '🪙', '💴', '💵', '💶', '💷', '💸', '💳', '🧾', '💹', '✉', '📧', '📨', '📩', '📤', '📥', '📦', '📫', '📪', '📬', '📭', '📮', '🗳', '✏', '✒', '🖋', '🖊', '🖌', '🖍', '📝', '💼', '📁', '📂', '🗂', '📅', '📆', '🗒', '🗓', '📇', '📈', '📉', '📊', '📋', '📌', '📍', '📎', '🖇', '📏', '📐', '✂', '🗃', '🗄', '🗑', '🔒', '🔓', '🔏', '🔐', '🔑', '🗝', '🔨', '🪓', '⛏', '⚒', '🛠', '🗡', '⚔', '🔫', '🪃', '🏹', '🛡', '🪚', '🔧', '🪛', '🔩', '⚙', '🗜', '⚖', '🦯', '🔗', '⛓', '🪝', '🧰', '🧲', '🪜', '⚗', '🧪', '🧫', '🧬', '🔬', '🔭', '📡', '💉', '🩸', '💊', '🩹', '🩼', '🩺', '🩻', '🚪', '🛗', '🪞', '🪟', '🛏', '🛋', '🪑', '🚽', '🪠', '🚿', '🛁', '🪤', '🪒', '🧴', '🧷', '🧹', '🧺', '🧻', '🪣', '🧼', '🫧', '🪥', '🧽', '🧯', '🛒', '🚬', '⚰', '🪦', '⚱', '🗿', '🪧', '🪪', '🏧', '🚮', '🚰', '♿', '🚹', '🚺', '🚻', '🚼', '🚾', '🛂', '🛃', '🛄', '🛅', '⚠', '🚸', '⛔', '🚫', '🚳', '🚭', '🚯', '🚱', '🚷', '📵', '🔞', '☢', '☣', '⬆', '↗', '➡', '↘', '⬇', '↙', '⬅', '↖', '↕', '↔', '↩', '↪', '⤴', '⤵', '🔃', '🔄', '🔙', '🔚', '🔛', '🔜', '🔝', '🛐', '⚛', '🕉', '✡', '☸', '☯', '✝', '☦', '☪', '☮', '🕎', '🔯', '♈', '♉', '♊', '♋', '♌', '♍', '♎', '♏', '♐', '♑', '♒', '♓', '⛎', '🔀', '🔁', '🔂', '▶', '⏩', '⏭', '⏯', '◀', '⏪', '⏮', '🔼', '⏫', '🔽', '⏬', '⏸', '⏹', '⏺', '⏏', '🎦', '🔅', '🔆', '📶', '📳', '📴', '♀', '♂', '⚧', '✖', '➕', '➖', '➗', '🟰', '♾', '‼', '⁉', '❓', '❔', '❕', '❗', '〰', '💱', '💲', '⚕', '♻', '⚜', '🔱', '📛', '🔰', '⭕', '✅', '☑', '✔', '❌', '❎', '➰', '➿', '〽', '✳', '✴', '❇', '©', '®', '™', '#️⃣', '*️⃣', '0️⃣', '1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟', '🔠', '🔡', '🔢', '🔣', '🔤', '🅰', '🆎', '🅱', '🆑', '🆒', '🆓', 'ℹ', '🆔', 'Ⓜ', '🆕', '🆖', '🅾', '🆗', '🅿', '🆘', '🆙', '🆚', '🈁', '🈂', '🈷', '🈶', '🈯', '🉐', '🈹', '🈚', '🈲', '🉑', '🈸', '🈴', '🈳', '㊗', '㊙', '🈺', '🈵', '🔴', '🟠', '🟡', '🟢', '🔵', '🟣', '🟤', '⚫', '⚪', '🟥', '🟧', '🟨', '🟩', '🟦', '🟪', '🟫', '⬛', '⬜', '◼', '◻', '◾', '◽', '▪', '▫', '🔶', '🔷', '🔸', '🔹', '🔺', '🔻', '💠', '🔘', '🔳', '🔲', '🏁', '🚩', '🎌', '🏴', '🏳', '🏳️‍🌈', '🏳️‍⚧️', '🏴‍☠️', '🇦🇨', '🇦🇩', '🇦🇪', '🇦🇫', '🇦🇬', '🇦🇮', '🇦🇱', '🇦🇲', '🇦🇴', '🇦🇶', '🇦🇷', '🇦🇸', '🇦🇹', '🇦🇺', '🇦🇼', '🇦🇽', '🇦🇿', '🇧🇦', '🇧🇧', '🇧🇩', '🇧🇪', '🇧🇫', '🇧🇬', '🇧🇭', '🇧🇮', '🇧🇯', '🇧🇱', '🇧🇲', '🇧🇳', '🇧🇴', '🇧🇶', '🇧🇷', '🇧🇸', '🇧🇹', '🇧🇻', '🇧🇼', '🇧🇾', '🇧🇿', '🇨🇦', '🇨🇨', '🇨🇩', '🇨🇫', '🇨🇬', '🇨🇭', '🇨🇮', '🇨🇰', '🇨🇱', '🇨🇲', '🇨🇳', '🇨🇴', '🇨🇵', '🇨🇷', '🇨🇺', '🇨🇻', '🇨🇼', '🇨🇽', '🇨🇾', '🇨🇿', '🇩🇪', '🇩🇬', '🇩🇯', '🇩🇰', '🇩🇲', '🇩🇴', '🇩🇿', '🇪🇦', '🇪🇨', '🇪🇪', '🇪🇬', '🇪🇭', '🇪🇷', '🇪🇸', '🇪🇹', '🇪🇺', '🇫🇮', '🇫🇯', '🇫🇰', '🇫🇲', '🇫🇴', '🇫🇷', '🇬🇦', '🇬🇧', '🇬🇩', '🇬🇪', '🇬🇫', '🇬🇬', '🇬🇭', '🇬🇮', '🇬🇱', '🇬🇲', '🇬🇳', '🇬🇵', '🇬🇶', '🇬🇷', '🇬🇸', '🇬🇹', '🇬🇺', '🇬🇼', '🇬🇾', '🇭🇰', '🇭🇲', '🇭🇳', '🇭🇷', '🇭🇹', '🇭🇺', '🇮🇨', '🇮🇩', '🇮🇪', '🇮🇱', '🇮🇲', '🇮🇳', '🇮🇴', '🇮🇶', '🇮🇷', '🇮🇸', '🇮🇹', '🇯🇪', '🇯🇲', '🇯🇴', '🇯🇵', '🇰🇪', '🇰🇬', '🇰🇭', '🇰🇮', '🇰🇲', '🇰🇳', '🇰🇵', '🇰🇷', '🇰🇼', '🇰🇾', '🇰🇿', '🇱🇦', '🇱🇧', '🇱🇨', '🇱🇮', '🇱🇰', '🇱🇷', '🇱🇸', '🇱🇹', '🇱🇺', '🇱🇻', '🇱🇾', '🇲🇦', '🇲🇨', '🇲🇩', '🇲🇪', '🇲🇫', '🇲🇬', '🇲🇭', '🇲🇰', '🇲🇱', '🇲🇲', '🇲🇳', '🇲🇴', '🇲🇵', '🇲🇶', '🇲🇷', '🇲🇸', '🇲🇹', '🇲🇺', '🇲🇻', '🇲🇼', '🇲🇽', '🇲🇾', '🇲🇿', '🇳🇦', '🇳🇨', '🇳🇪', '🇳🇫', '🇳🇬', '🇳🇮', '🇳🇱', '🇳🇴', '🇳🇵', '🇳🇷', '🇳🇺', '🇳🇿', '🇴🇲', '🇵🇦', '🇵🇪', '🇵🇫', '🇵🇬', '🇵🇭', '🇵🇰', '🇵🇱', '🇵🇲', '🇵🇳', '🇵🇷', '🇵🇸', '🇵🇹', '🇵🇼', '🇵🇾', '🇶🇦', '🇷🇪', '🇷🇴', '🇷🇸', '🇷🇺', '🇷🇼', '🇸🇦', '🇸🇧', '🇸🇨', '🇸🇩', '🇸🇪', '🇸🇬', '🇸🇭', '🇸🇮', '🇸🇯', '🇸🇰', '🇸🇱', '🇸🇲', '🇸🇳', '🇸🇴', '🇸🇷', '🇸🇸', '🇸🇹', '🇸🇻', '🇸🇽', '🇸🇾', '🇸🇿', '🇹🇦', '🇹🇨', '🇹🇩', '🇹🇫', '🇹🇬', '🇹🇭', '🇹🇯', '🇹🇰', '🇹🇱', '🇹🇲', '🇹🇳', '🇹🇴', '🇹🇷', '🇹🇹', '🇹🇻', '🇹🇼', '🇹🇿', '🇺🇦', '🇺🇬', '🇺🇲', '🇺🇳', '🇺🇸', '🇺🇾', '🇺🇿', '🇻🇦', '🇻🇨', '🇻🇪', '🇻🇬', '🇻🇮', '🇻🇳', '🇻🇺', '🇼🇫', '🇼🇸', '🇽🇰', '🇾🇪', '🇾🇹', '🇿🇦', '🇿🇲', '🇿🇼', '🏴󠁧󠁢󠁥󠁮󠁧󠁿', '🏴󠁧󠁢󠁳󠁣󠁴󠁿', '🏴󠁧󠁢󠁷󠁬󠁳󠁿'];
        await interaction.channel?.send(emojis[~~(Math.random() * emojis.length)]);
        await timeout(800);
    }
}

/**
 * Formats a string so that it properly displays in the list function.
 */
const lFrmt = (text: string, maxLength: number): string => text.concat("                                   ").substring(0, maxLength);

/**
 * Lists all of the current deletion routines.
 */
async function List(interaction: ChatInputCommandInteraction<CacheType>) {
    const numPages = Math.ceil(activeDeleteRoutines.length / 10);

    let message = "================================= Active Deletion Routines: ===============================";
    await interaction.reply(message);

    for(let j = 0; j < numPages; j++) {
        message = "```\n";
        message += "ID      | Channel           | Status                        | Deleted  | Routines | Params \n";
        message += "===============================================================================================\n"
        for (let i = j * 10; i < activeDeleteRoutines.length && i < (j + 1) * 10; i++) {
            const routine = activeDeleteRoutines[i];
            const channel = await interaction.guild?.channels.fetch(routine.channelId);
            message += `${lFrmt(routine.id, 7)} | #${lFrmt(channel?.name ?? "", 16)} | ${lFrmt(routine.status, 29)} | ${lFrmt(routine.deleted.toString(), 8)} | ${lFrmt(routine.routines.toString(), 8)} | `;
    
            if (routine.days < 0) message += `Interval`;
            else message += `${routine.days} Days Old`;
    
            message += '\n'
        }
        message += '```\n'
        
        await interaction?.channel?.send(message);
        await timeout(QUERY_THROTTLE);
    }

}

