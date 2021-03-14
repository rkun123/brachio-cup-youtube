import { Module, VuexModule, Mutation, Action } from 'vuex-module-decorators'
import { UserStore } from '../store'
import { $axios } from '~/utils/api'
import { db } from '~/plugins/Auth/firebase'
import firebase from 'firebase'

export type Channel = {
  youtubeChannelId?: string | null,
  name?: string | null,
  avatar?: string | null,
  favorite: boolean,
  videos: any
}

type Video = {
  videoId?: string | null,
  videoTitle?: string | null,
  videoThumbnail?: string | null,
}

type favoPayload = {
  youtubeChannelId : string,
  favorite: boolean
}

async function getSubscriptionCollection(): Promise<firebase.firestore.CollectionReference<firebase.firestore.DocumentData> | null> {
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


  @Mutation
  private setChannels (channels: Channel[]) {
    this.channels = channels
  }

  @Mutation
  private setList (items: any) {
    for (let i = 0; i < items.length; i++) {
      const data = items[i].snippet
      const chan: Channel = {
        youtubeChannelId: data.resourceId.channelId,
        name: data.title,
        avatar: data.thumbnails.medium.url,
        favorite: false,
        videos: []
      }
      const some = this.channels.some(
        b => b.youtubeChannelId === chan.youtubeChannelId
      )
      if (!some) {
        this.channels.push(chan)
      }
    }
  }

  @Mutation
  private changeFavo (key: favoPayload) {
    const target = this.channels.find((search) => {
      return search.youtubeChannelId === key.youtubeChannelId
    })
    if (target === undefined) { return }
    target.favorite = key.favorite
  }

  @Mutation
  private pushVideo (items: any) {
    const target = this.channels.find((search) => {
      return search.youtubeChannelId === items[0].snippet.channelId
    })
    if (target) {
      for (let i = 0; i < items.length; i++) {
        const data = items[i].snippet
        const chan: Video = {
          videoId: items[i].id.videoId,
          videoTitle: data.title,
          videoThumbnail: data.thumbnails.medium.url
        }
        const some = (target.videos as Video[]).some(
          b => b.videoId === chan.videoId
        )
        if (!some) {
          target.videos.push(chan)
        }
      }
    }
  }

  @Action
  // eslint-disable-next-line camelcase
  async setVideo (youtubeChannelId: string) {
    const params = {
      part: 'snippet',
      channelId: youtubeChannelId,
      maxResults: 2, // 本番環境では50にする。
      order: 'date'
    }
    await $axios
      .get('https://www.googleapis.com/youtube/v3/search', { params })
      .then((result) => {
        const items = result.data.items
        this.pushVideo(items)
      })
  }

  // FirestoreよりすべてのチャンネルのFavoを取得してStoreのChannelsに適用するAction
  @Action({ rawError: true})
  async fetchAndApplyFavoToAllChannels() {
    const subscriptionCollection = await getSubscriptionCollection()
    const newChannels = await Promise.all(this.channels.map(async channel => {
      console.info(channel)
      const subscriptionDoc = await subscriptionCollection!.doc(channel.youtubeChannelId!).get()
      if(!subscriptionDoc.exists) return channel
      return {
        ...channel,
        favorite: subscriptionDoc.data()!.favorite
      }
    }))
    console.info('Channels', newChannels)
    if (newChannels === undefined) { return }
    this.setChannels(newChannels)
  }

  // StoreのChannelsをFirestoreへ送り更新するAction
  @Action({ rawError: true})
  async postSubscribeChannels() {
    const me = UserStore.getuser
    if (!me.uid) { return }
    const subscriptionCollections = await db
      .collection('users')
      .doc(me.uid!)
      .collection('subscriptions')

    await this.channels.forEach(async (channel) => {
      subscriptionCollections.doc(channel.youtubeChannelId!).set(channel)
    })
  }

  // Firestoreへ指定のChannelのFavoを送り更新するAction
  @Action({ rawError: true})
  async postFavoState(youtubeChannelId: string, state: boolean) {
    (await getSubscriptionCollection())!
      .doc(youtubeChannelId)
      .update({
        favorite: state
      })
  }

  @Action({ rawError: true })
  async setFavo (payload: favoPayload) {
    this.changeFavo(payload)
    await this.postFavoState(payload.youtubeChannelId, payload.favorite)
  }

  // Firestoreに保存済の自分の登録チャンネルを取得し、Storeに格納するアクション
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
    console.debug(snapshot)
    console.debug(snapshot.docs)
    const channels = rawChannels.map((doc) => {
      return doc.data() as Channel
    })
    this.setChannels(channels)
    
  }

  // APIから自分の登録チャンネルを取得するし、Store、Firestoreに格納するアクション
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
    $axios
      .get('https://www.googleapis.com/youtube/v3/subscriptions', { params })
      .then((result) => {
        const items = result.data.items
        this.setList(items)
      })
      .then(() => {
        // FirestoreからStoreのChannelsへFavoriteの情報を取得、適用する。
        this.fetchAndApplyFavoToAllChannels()
        // Favorite情報適用済のStoreのChannelsをFirestoreへ送り、更新する。
        this.postSubscribeChannels()
      })
  }
}
