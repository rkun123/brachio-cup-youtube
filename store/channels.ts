import { Module, VuexModule, Mutation, Action } from 'vuex-module-decorators'
import { UserStore } from '../store'
import { $axios } from '~/utils/api'
import { db } from '~/plugins/Auth/firebase'
import firebase from 'firebase'
import { fetchVideosByChannel, fetchVideosByChannelFromAPI, postVideosByChannel } from './videos'

export type Channel = {
  youtubeChannelId?: string | null,
  name?: string | null,
  avatar?: string | null,
  favorite: boolean,
  videos?: Video[]
}

export type Video = {
  videoId?: string | null,
  videoTitle?: string | null,
  videoThumbnail?: string | null,
}

export type favoPayload = {
  youtubeChannelId : string,
  favorite: boolean
}

export async function getSubscriptionCollection(): Promise<firebase.firestore.CollectionReference<firebase.firestore.DocumentData> | null> {
  const me = UserStore.getuser
  if(!me.uid) return null
  return await db
    .collection('users')
    .doc(me.uid!)
    .collection('subscriptions')
}

@Module({
  name: 'channels',
  stateFactory: true,
  namespaced: true
})
export default class Channels extends VuexModule {
  private channels: Channel[] = [];

  public get getchannels () {
    return this.channels
  }

  public get getChannelsSortedByFav() {
    const favChannels = this.channels.filter((channel) => (channel.favorite === true))
    const notFavChannels = this.channels.filter((channel) => (channel.favorite === false))
    return favChannels.concat(notFavChannels)
  }


  @Mutation
  private setChannels (channels: Channel[]) {
    this.channels = channels
  }

  @Mutation
  private changeFavo (key: favoPayload) {
    const target = this.channels.find((search) => {
      return search.youtubeChannelId === key.youtubeChannelId
    })
    if (target === undefined) { return }
    target.favorite = key.favorite
  }

  // FirestoreよりすべてのチャンネルのFavoを取得してStoreのChannelsに適用するAction
  @Action({ rawError: true})
  async fetchAndApplyFavoToAllChannels() {
    const subscriptionCollection = await getSubscriptionCollection()
    const newChannels = await Promise.all(this.channels.map(async channel => {
      const subscriptionDoc = await subscriptionCollection!.doc(channel.youtubeChannelId!).get()
      if(!subscriptionDoc.exists) return channel
      return {
        ...channel,
        favorite: subscriptionDoc.data()!.favorite
      }
    }))
    if (newChannels === undefined) { return }
    this.setChannels(newChannels)
  }

  // StoreのChannels(Videosも含む)をFirestoreへ送り更新するAction
  @Action({ rawError: true})
  async postSubscribeChannels() {
    const me = UserStore.getuser
    if (!me.uid) { return }
    const subscriptionCollections =  await getSubscriptionCollection()
    this.channels.forEach((channel) => {
      subscriptionCollections!.doc(channel.youtubeChannelId!).set(channel)
      postVideosByChannel(channel.videos!, channel.youtubeChannelId!)
    })
  }

  // Firestoreへ指定のChannelのFavoを送り更新するAction
  @Action({ rawError: true})
  async postFavoState(payload: favoPayload) {
    console.info('postFavoState', payload.youtubeChannelId, payload.favorite);
    (await getSubscriptionCollection())!
      .doc(payload.youtubeChannelId)
      .update({
        favorite: payload.favorite
      })
  }

  @Action({ rawError: true })
  async setFavo (payload: favoPayload) {
    console.info('setFavo', payload)
    this.changeFavo(payload)
    await this.postFavoState(payload)
  }

  // Firestoreから自分の登録チャンネルを取得し、Storeに格納するアクション
  @Action({ rawError: true})
  async fetchSubscriptions() {
    const subscriptionCollection = await getSubscriptionCollection()
    if(subscriptionCollection === null) {
      console.error('Undefined subscription collection')
      return
    }
    const snapshot = await subscriptionCollection.get()
    if(snapshot.empty) {
      // Firestoreにチャンネルの情報がないため、新たにAPIから取得
      await this.fetchSubscriptionsFromAPI()
      return
    }
    const rawChannels = snapshot.docs
    const channelsWithoutVideos = rawChannels.map((doc) => (doc.data() as Channel))

    // 各Channelの動画を取得
    const channels = await Promise.all(channelsWithoutVideos.map(async (channel) => {
      const videos = await fetchVideosByChannel(channel.youtubeChannelId!)
      return {
        ...channel,
        videos
      }
    }))
    this.setChannels(channels)
  }

  // APIから自分の登録チャンネルを取得し、Store、Firestoreに格納するアクション
  @Action({ rawError: true })
  async fetchSubscriptionsFromAPI () {
    console.info(UserStore.getuser.accessToken)
    await $axios.setHeader(
      'Authorization',
      'Bearer ' + UserStore.getuser.accessToken
    )
    const params = {
      part: 'snippet',
      mine: true,
      maxResults: 2, // 本番環境では50にする。
      key: String(process.env.YOUTUBE_API_KEY)
    }
    const result = await $axios
      .get('https://www.googleapis.com/youtube/v3/subscriptions', { params })
    const items = result.data.items as any[]
    const channelsWithoutVideos = items.map((item: any): Channel => {
      const data = item.snippet
      return ({
        youtubeChannelId: data.resourceId.channelId,
        name: data.title,
        avatar: data.thumbnails.medium.url,
        favorite: false,
        videos: []
      } as Channel)
    })

    // 各Channelの動画を取得
    const channels = await Promise.all(channelsWithoutVideos.map(async (channel: Channel) => {
      const videos = await fetchVideosByChannelFromAPI(channel.youtubeChannelId!)
      return {
        ...channel,
        videos
      }
    }))

    await this.setChannels(channels)
    // FirestoreからStoreのChannelsへFavoriteの情報を取得、適用する。
    await this.fetchAndApplyFavoToAllChannels()
    // Favorite情報適用済のStoreのChannelsをFirestoreへ送り、更新する。
    await this.postSubscribeChannels()
  }
}
