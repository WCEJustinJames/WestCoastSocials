export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  __InternalSupabase: {
    PostgrestVersion: '14.5'
  }
  public: {
    Tables: {
      inbox_group_post: {
        Row: {
          id: number
          chat_id: string | null
          message_id: string | null
          roster_hash: string | null
          updated_at: string
        }
        Insert: {
          id?: number
          chat_id?: string | null
          message_id?: string | null
          roster_hash?: string | null
          updated_at?: string
        }
        Update: {
          id?: number
          chat_id?: string | null
          message_id?: string | null
          roster_hash?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      inbox_sync_heartbeat: {
        Row: {
          id: number
          last_run: string
          host: string | null
          note: string | null
        }
        Insert: {
          id: number
          last_run?: string
          host?: string | null
          note?: string | null
        }
        Update: {
          id?: number
          last_run?: string
          host?: string | null
          note?: string | null
        }
        Relationships: []
      }
      inbox_td_attendees: {
        Row: {
          id: string
          sheet_id: string
          sheet_title: string | null
          venue: string | null
          game_date: string | null
          name: string
          is_winner: boolean
          category: string | null
          synced_at: string
        }
        Insert: {
          id?: string
          sheet_id: string
          sheet_title?: string | null
          venue?: string | null
          game_date?: string | null
          name: string
          is_winner?: boolean
          category?: string | null
          synced_at?: string
        }
        Update: {
          id?: string
          sheet_id?: string
          sheet_title?: string | null
          venue?: string | null
          game_date?: string | null
          name?: string
          is_winner?: boolean
          category?: string | null
          synced_at?: string
        }
        Relationships: []
      }
      inbox_fb_friends: {
        Row: { id: number; names: Json; updated_at: string }
        Insert: { id?: number; names?: Json; updated_at?: string }
        Update: { id?: number; names?: Json; updated_at?: string }
        Relationships: []
      }
      inbox_batch_items: {
        Row: {
          batch_id: string
          claimed_at: string | null
          created_at: string
          data: Json
          guard_flag: boolean
          guard_reason: string | null
          id: string
          identity_id: string | null
          person_id: string | null
          rendered_text: string
          sent_message_id: string | null
          status: Database['public']['Enums']['inbox_batch_item_status']
        }
        Insert: {
          batch_id: string
          claimed_at?: string | null
          created_at?: string
          data?: Json
          guard_flag?: boolean
          guard_reason?: string | null
          id?: string
          identity_id?: string | null
          person_id?: string | null
          rendered_text: string
          sent_message_id?: string | null
          status?: Database['public']['Enums']['inbox_batch_item_status']
        }
        Update: {
          batch_id?: string
          claimed_at?: string | null
          created_at?: string
          data?: Json
          guard_flag?: boolean
          guard_reason?: string | null
          id?: string
          identity_id?: string | null
          person_id?: string | null
          rendered_text?: string
          sent_message_id?: string | null
          status?: Database['public']['Enums']['inbox_batch_item_status']
        }
        Relationships: [
          {
            foreignKeyName: 'inbox_batch_items_batch_id_fkey'
            columns: ['batch_id']
            isOneToOne: false
            referencedRelation: 'inbox_batches'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'inbox_batch_items_identity_id_fkey'
            columns: ['identity_id']
            isOneToOne: false
            referencedRelation: 'inbox_identities'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'inbox_batch_items_person_id_fkey'
            columns: ['person_id']
            isOneToOne: false
            referencedRelation: 'inbox_people'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'inbox_batch_items_sent_message_fk'
            columns: ['sent_message_id']
            isOneToOne: false
            referencedRelation: 'inbox_messages'
            referencedColumns: ['id']
          },
        ]
      }
      inbox_batches: {
        Row: {
          created_at: string
          created_by: string | null
          id: string
          name: string
          status: Database['public']['Enums']['inbox_batch_status']
          template_body: string
          variation_schema: Json
          scheduled_for: string | null
          approved_at: string | null
          attachment_data: string | null
          attachment_name: string | null
          attachment_mime: string | null
          is_outreach: boolean
          venue: string | null
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          id?: string
          name: string
          status?: Database['public']['Enums']['inbox_batch_status']
          template_body: string
          variation_schema?: Json
          scheduled_for?: string | null
          approved_at?: string | null
          attachment_data?: string | null
          attachment_name?: string | null
          attachment_mime?: string | null
          is_outreach?: boolean
          venue?: string | null
        }
        Update: {
          created_at?: string
          created_by?: string | null
          id?: string
          name?: string
          status?: Database['public']['Enums']['inbox_batch_status']
          template_body?: string
          variation_schema?: Json
          scheduled_for?: string | null
          approved_at?: string | null
          attachment_data?: string | null
          attachment_name?: string | null
          attachment_mime?: string | null
          is_outreach?: boolean
          venue?: string | null
        }
        Relationships: []
      }
      inbox_conversations: {
        Row: {
          account_id: string | null
          adapter: Database['public']['Enums']['inbox_adapter']
          auto_send_enabled: boolean
          context_resolved_at: string | null
          created_at: string
          external_chat_id: string
          id: string
          last_activity: string | null
          network: string
          person_id: string | null
          title: string | null
          type: Database['public']['Enums']['inbox_conversation_type']
          unread_count: number
          hidden: boolean
        }
        Insert: {
          account_id?: string | null
          adapter: Database['public']['Enums']['inbox_adapter']
          auto_send_enabled?: boolean
          context_resolved_at?: string | null
          created_at?: string
          external_chat_id: string
          id?: string
          last_activity?: string | null
          network: string
          person_id?: string | null
          title?: string | null
          type?: Database['public']['Enums']['inbox_conversation_type']
          unread_count?: number
          hidden?: boolean
        }
        Update: {
          account_id?: string | null
          adapter?: Database['public']['Enums']['inbox_adapter']
          auto_send_enabled?: boolean
          context_resolved_at?: string | null
          created_at?: string
          external_chat_id?: string
          id?: string
          last_activity?: string | null
          network?: string
          person_id?: string | null
          title?: string | null
          type?: Database['public']['Enums']['inbox_conversation_type']
          unread_count?: number
          hidden?: boolean
        }
        Relationships: [
          {
            foreignKeyName: 'inbox_conversations_person_id_fkey'
            columns: ['person_id']
            isOneToOne: false
            referencedRelation: 'inbox_people'
            referencedColumns: ['id']
          },
        ]
      }
      inbox_drafts: {
        Row: {
          content: string
          conversation_id: string
          created_at: string
          generated_by: string | null
          id: string
          status: Database['public']['Enums']['inbox_draft_status']
          updated_at: string
          attachment_data: string | null
          attachment_name: string | null
          attachment_mime: string | null
        }
        Insert: {
          content: string
          conversation_id: string
          created_at?: string
          generated_by?: string | null
          id?: string
          status?: Database['public']['Enums']['inbox_draft_status']
          updated_at?: string
          attachment_data?: string | null
          attachment_name?: string | null
          attachment_mime?: string | null
        }
        Update: {
          content?: string
          conversation_id?: string
          created_at?: string
          generated_by?: string | null
          id?: string
          status?: Database['public']['Enums']['inbox_draft_status']
          updated_at?: string
          attachment_data?: string | null
          attachment_name?: string | null
          attachment_mime?: string | null
        }
        Relationships: [
          {
            foreignKeyName: 'inbox_drafts_conversation_id_fkey'
            columns: ['conversation_id']
            isOneToOne: false
            referencedRelation: 'inbox_conversations'
            referencedColumns: ['id']
          },
        ]
      }
      inbox_identities: {
        Row: {
          account_id: string | null
          adapter: Database['public']['Enums']['inbox_adapter']
          created_at: string
          external_id: string
          handle: string | null
          id: string
          is_primary: boolean
          match_confidence: number
          network: string
          person_id: string
        }
        Insert: {
          account_id?: string | null
          adapter: Database['public']['Enums']['inbox_adapter']
          created_at?: string
          external_id: string
          handle?: string | null
          id?: string
          is_primary?: boolean
          match_confidence?: number
          network: string
          person_id: string
        }
        Update: {
          account_id?: string | null
          adapter?: Database['public']['Enums']['inbox_adapter']
          created_at?: string
          external_id?: string
          handle?: string | null
          id?: string
          is_primary?: boolean
          match_confidence?: number
          network?: string
          person_id?: string
        }
        Relationships: [
          {
            foreignKeyName: 'inbox_identities_person_id_fkey'
            columns: ['person_id']
            isOneToOne: false
            referencedRelation: 'inbox_people'
            referencedColumns: ['id']
          },
        ]
      }
      inbox_messages: {
        Row: {
          adapter_source: Database['public']['Enums']['inbox_adapter']
          auto_handled: boolean
          batch_item_id: string | null
          conversation_id: string
          created_at: string
          direction: Database['public']['Enums']['inbox_direction']
          external_message_id: string
          id: string
          is_unread: boolean | null
          kind: Database['public']['Enums']['inbox_message_kind']
          network: string
          person_id: string | null
          raw: Json | null
          reply_intent: string | null
          reply_note: string | null
          reply_back_on: string | null
          action_resolved: boolean
          sender_id: string | null
          sender_name: string | null
          sort_key: string | null
          text: string | null
          timestamp: string
        }
        Insert: {
          adapter_source: Database['public']['Enums']['inbox_adapter']
          auto_handled?: boolean
          batch_item_id?: string | null
          conversation_id: string
          created_at?: string
          direction: Database['public']['Enums']['inbox_direction']
          external_message_id: string
          id?: string
          is_unread?: boolean | null
          kind?: Database['public']['Enums']['inbox_message_kind']
          network: string
          person_id?: string | null
          raw?: Json | null
          reply_intent?: string | null
          reply_note?: string | null
          reply_back_on?: string | null
          action_resolved?: boolean
          sender_id?: string | null
          sender_name?: string | null
          sort_key?: string | null
          text?: string | null
          timestamp: string
        }
        Update: {
          adapter_source?: Database['public']['Enums']['inbox_adapter']
          auto_handled?: boolean
          batch_item_id?: string | null
          conversation_id?: string
          created_at?: string
          direction?: Database['public']['Enums']['inbox_direction']
          external_message_id?: string
          id?: string
          is_unread?: boolean | null
          kind?: Database['public']['Enums']['inbox_message_kind']
          network?: string
          person_id?: string | null
          raw?: Json | null
          reply_intent?: string | null
          reply_note?: string | null
          reply_back_on?: string | null
          action_resolved?: boolean
          sender_id?: string | null
          sender_name?: string | null
          sort_key?: string | null
          text?: string | null
          timestamp?: string
        }
        Relationships: [
          {
            foreignKeyName: 'inbox_messages_batch_item_id_fkey'
            columns: ['batch_item_id']
            isOneToOne: false
            referencedRelation: 'inbox_batch_items'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'inbox_messages_conversation_id_fkey'
            columns: ['conversation_id']
            isOneToOne: false
            referencedRelation: 'inbox_conversations'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'inbox_messages_person_id_fkey'
            columns: ['person_id']
            isOneToOne: false
            referencedRelation: 'inbox_people'
            referencedColumns: ['id']
          },
        ]
      }
      inbox_outreach: {
        Row: {
          activity: string | null
          airtable_id: string
          beeper_chat_id: string | null
          beeper_contact_name: string | null
          email: string | null
          first_name: string | null
          game_type: string | null
          id: string
          last_active: string | null
          last_contacted: string | null
          last_name: string | null
          notes: string | null
          outreach_status: string | null
          preferred_channel: string | null
          staff: boolean
          tournament: boolean
          weekly: boolean
          cash: boolean
          fb_friend: boolean
          snooze_until: string | null
          fifo: boolean
          whale: boolean
          priority: boolean
          nickname: string | null
          contact_day: string | null
          contact_window: string | null
          contact_frequency_days: number | null
          rapport: number | null
          do_not_message: boolean
          hidden: boolean
          phone: string | null
          player_name: string | null
          region: string | null
          stakes: string[]
          synced_at: string
          venues: string[]
          source: string | null
          added_at: string | null
        }
        Insert: {
          activity?: string | null
          airtable_id: string
          beeper_chat_id?: string | null
          beeper_contact_name?: string | null
          email?: string | null
          first_name?: string | null
          game_type?: string | null
          id?: string
          last_active?: string | null
          last_contacted?: string | null
          last_name?: string | null
          notes?: string | null
          outreach_status?: string | null
          preferred_channel?: string | null
          staff?: boolean
          tournament?: boolean
          weekly?: boolean
          cash?: boolean
          fb_friend?: boolean
          snooze_until?: string | null
          fifo?: boolean
          whale?: boolean
          priority?: boolean
          nickname?: string | null
          contact_day?: string | null
          contact_window?: string | null
          contact_frequency_days?: number | null
          rapport?: number | null
          do_not_message?: boolean
          hidden?: boolean
          phone?: string | null
          player_name?: string | null
          region?: string | null
          stakes?: string[]
          synced_at?: string
          venues?: string[]
          source?: string | null
          added_at?: string | null
        }
        Update: {
          activity?: string | null
          airtable_id?: string
          beeper_chat_id?: string | null
          beeper_contact_name?: string | null
          email?: string | null
          first_name?: string | null
          game_type?: string | null
          id?: string
          last_active?: string | null
          last_contacted?: string | null
          last_name?: string | null
          notes?: string | null
          outreach_status?: string | null
          preferred_channel?: string | null
          staff?: boolean
          tournament?: boolean
          weekly?: boolean
          cash?: boolean
          fb_friend?: boolean
          snooze_until?: string | null
          fifo?: boolean
          whale?: boolean
          priority?: boolean
          nickname?: string | null
          contact_day?: string | null
          contact_window?: string | null
          contact_frequency_days?: number | null
          rapport?: number | null
          do_not_message?: boolean
          hidden?: boolean
          phone?: string | null
          player_name?: string | null
          region?: string | null
          stakes?: string[]
          synced_at?: string
          venues?: string[]
          source?: string | null
          added_at?: string | null
        }
        Relationships: []
      }
      inbox_receipts: {
        Row: {
          amount: number | null
          captured_at: string | null
          chat_id: string | null
          created_at: string
          external_message_id: string
          first_name: string | null
          game_type: string | null
          id: string
          image_file: string | null
          mobile: string | null
          paid: boolean | null
          player_name: string | null
          raw_extract: Json | null
          receipt_date: string | null
          review_status: string
          surname: string | null
          total_winnings: number | null
          venue: string | null
          club: string | null
        }
        Insert: {
          amount?: number | null
          captured_at?: string | null
          chat_id?: string | null
          created_at?: string
          external_message_id: string
          first_name?: string | null
          game_type?: string | null
          id?: string
          image_file?: string | null
          mobile?: string | null
          paid?: boolean | null
          player_name?: string | null
          raw_extract?: Json | null
          receipt_date?: string | null
          review_status?: string
          surname?: string | null
          total_winnings?: number | null
          venue?: string | null
          club?: string | null
        }
        Update: {
          amount?: number | null
          captured_at?: string | null
          chat_id?: string | null
          created_at?: string
          external_message_id?: string
          first_name?: string | null
          game_type?: string | null
          id?: string
          image_file?: string | null
          mobile?: string | null
          paid?: boolean | null
          player_name?: string | null
          raw_extract?: Json | null
          receipt_date?: string | null
          review_status?: string
          surname?: string | null
          total_winnings?: number | null
          venue?: string | null
          club?: string | null
        }
        Relationships: []
      }
      inbox_people: {
        Row: {
          created_at: string
          display_name: string | null
          id: string
          last_outbound_at: string | null
          notes: string | null
          tags: string[]
          updated_at: string
        }
        Insert: {
          created_at?: string
          display_name?: string | null
          id?: string
          last_outbound_at?: string | null
          notes?: string | null
          tags?: string[]
          updated_at?: string
        }
        Update: {
          created_at?: string
          display_name?: string | null
          id?: string
          last_outbound_at?: string | null
          notes?: string | null
          tags?: string[]
          updated_at?: string
        }
        Relationships: []
      }
      inbox_lists: {
        Row: {
          id: string
          name: string
          event_day: string | null
          event_time: string | null
          venue: string | null
          game_type: string | null
          notes: string | null
          created_at: string
        }
        Insert: {
          id?: string
          name: string
          event_day?: string | null
          event_time?: string | null
          venue?: string | null
          game_type?: string | null
          notes?: string | null
          created_at?: string
        }
        Update: {
          id?: string
          name?: string
          event_day?: string | null
          event_time?: string | null
          venue?: string | null
          game_type?: string | null
          notes?: string | null
          created_at?: string
        }
        Relationships: []
      }
      inbox_list_members: {
        Row: {
          list_id: string
          outreach_id: string
          added_at: string
          pinned: boolean
          added_by: string
        }
        Insert: {
          list_id: string
          outreach_id: string
          added_at?: string
          pinned?: boolean
          added_by?: string
        }
        Update: {
          list_id?: string
          outreach_id?: string
          added_at?: string
          pinned?: boolean
          added_by?: string
        }
        Relationships: [
          {
            foreignKeyName: 'inbox_list_members_list_id_fkey'
            columns: ['list_id']
            isOneToOne: false
            referencedRelation: 'inbox_lists'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'inbox_list_members_outreach_id_fkey'
            columns: ['outreach_id']
            isOneToOne: false
            referencedRelation: 'inbox_outreach'
            referencedColumns: ['id']
          },
        ]
      }
      inbox_schedules: {
        Row: {
          id: string
          name: string
          venue: string | null
          game_type: string
          day_of_week: number
          event_time: string | null
          list_id: string | null
          template_body: string
          lead_days: number
          active: boolean
          last_materialised_for: string | null
          created_at: string
        }
        Insert: {
          id?: string
          name: string
          venue?: string | null
          game_type?: string
          day_of_week: number
          event_time?: string | null
          list_id?: string | null
          template_body: string
          lead_days?: number
          active?: boolean
          last_materialised_for?: string | null
          created_at?: string
        }
        Update: {
          id?: string
          name?: string
          venue?: string | null
          game_type?: string
          day_of_week?: number
          event_time?: string | null
          list_id?: string | null
          template_body?: string
          lead_days?: number
          active?: boolean
          last_materialised_for?: string | null
          created_at?: string
        }
        Relationships: [
          {
            foreignKeyName: 'inbox_schedules_list_id_fkey'
            columns: ['list_id']
            isOneToOne: false
            referencedRelation: 'inbox_lists'
            referencedColumns: ['id']
          },
        ]
      }
      inbox_transfers: {
        Row: {
          id: string
          sheet_id: string
          sheet_title: string | null
          tab_title: string
          game_date: string | null
          venue: string | null
          kind: string
          direction: string
          row_num: number
          name: string | null
          amount: string | null
          receipt: string | null
          wcp_verified: string | null
          time_stamp: string | null
          pay_method: string | null
          notes: string | null
          office_confirm: string
          confirm_col: string
          receipt_col: string | null
          confirm_state: string
          confirm_ref: string | null
          pending: boolean
          synced_at: string
        }
        Insert: {
          id?: string
          sheet_id: string
          sheet_title?: string | null
          tab_title: string
          game_date?: string | null
          venue?: string | null
          kind: string
          direction: string
          row_num: number
          name?: string | null
          amount?: string | null
          receipt?: string | null
          wcp_verified?: string | null
          time_stamp?: string | null
          pay_method?: string | null
          notes?: string | null
          office_confirm?: string
          confirm_col: string
          receipt_col?: string | null
          confirm_state?: string
          confirm_ref?: string | null
          pending?: boolean
          synced_at?: string
        }
        Update: {
          id?: string
          sheet_id?: string
          sheet_title?: string | null
          tab_title?: string
          game_date?: string | null
          venue?: string | null
          kind?: string
          direction?: string
          row_num?: number
          name?: string | null
          amount?: string | null
          receipt?: string | null
          wcp_verified?: string | null
          time_stamp?: string | null
          pay_method?: string | null
          notes?: string | null
          office_confirm?: string
          confirm_col?: string
          receipt_col?: string | null
          confirm_state?: string
          confirm_ref?: string | null
          pending?: boolean
          synced_at?: string
        }
        Relationships: []
      }
      inbox_emails: {
        Row: {
          id: string
          gmail_id: string
          thread_id: string | null
          from_name: string | null
          from_email: string | null
          subject: string | null
          snippet: string | null
          received_at: string | null
          resolved: boolean
          synced_at: string
        }
        Insert: {
          id?: string
          gmail_id: string
          thread_id?: string | null
          from_name?: string | null
          from_email?: string | null
          subject?: string | null
          snippet?: string | null
          received_at?: string | null
          resolved?: boolean
          synced_at?: string
        }
        Update: {
          id?: string
          gmail_id?: string
          thread_id?: string | null
          from_name?: string | null
          from_email?: string | null
          subject?: string | null
          snippet?: string | null
          received_at?: string | null
          resolved?: boolean
          synced_at?: string
        }
        Relationships: []
      }
      inbox_invite_variants: {
        Row: {
          id: string
          venue: string | null
          body: string
          active: boolean
          created_at: string
        }
        Insert: {
          id?: string
          venue?: string | null
          body: string
          active?: boolean
          created_at?: string
        }
        Update: {
          id?: string
          venue?: string | null
          body?: string
          active?: boolean
          created_at?: string
        }
        Relationships: []
      }
      social_posts: {
        Row: {
          id: string
          title: string
          body: string | null
          asset_url: string | null
          platforms: string[]
          scheduled_at: string | null
          repeat_rule: string
          repeat_until: string | null
          status: string
          postiz_id: string | null
          post_error: string | null
          posted_at: string | null
          created_at: string
        }
        Insert: {
          id?: string
          title: string
          body?: string | null
          asset_url?: string | null
          platforms?: string[]
          scheduled_at?: string | null
          repeat_rule?: string
          repeat_until?: string | null
          status?: string
          postiz_id?: string | null
          post_error?: string | null
          posted_at?: string | null
          created_at?: string
        }
        Update: {
          id?: string
          title?: string
          body?: string | null
          asset_url?: string | null
          platforms?: string[]
          scheduled_at?: string | null
          repeat_rule?: string
          repeat_until?: string | null
          status?: string
          postiz_id?: string | null
          post_error?: string | null
          posted_at?: string | null
          created_at?: string
        }
        Relationships: []
      }
      klaviyo_pushes: {
        Row: {
          id: string
          name: string
          subject: string | null
          body: string | null
          segment: string
          status: string
          stats: { emails?: number; list_id?: string } | null
          push_error: string | null
          created_at: string
          sent_at: string | null
        }
        Insert: {
          id?: string
          name: string
          subject?: string | null
          body?: string | null
          segment?: string
          status?: string
          stats?: { emails?: number; list_id?: string } | null
          push_error?: string | null
          created_at?: string
          sent_at?: string | null
        }
        Update: {
          id?: string
          name?: string
          subject?: string | null
          body?: string | null
          segment?: string
          status?: string
          stats?: { emails?: number; list_id?: string } | null
          push_error?: string | null
          created_at?: string
          sent_at?: string | null
        }
        Relationships: []
      }
    }
    Views: {
      inbox_attendance_norm: {
        Row: {
          norm: string | null
          venue: string | null
          fmt: string
          d: string | null
        }
        Relationships: []
      }
      inbox_attendance_stats: {
        Row: {
          norm: string
          games: number
          tourney_games: number
          cash_games: number
          games_10w: number
          first_seen: string | null
          last_seen: string | null
          venues: string[] | null
        }
        Relationships: []
      }
      inbox_batch_conversion: {
        Row: {
          batch_id: string
          name: string
          venue: string | null
          created_at: string
          sent: number
          replied: number
          yes: number
          no: number
          maybe: number
        }
        Relationships: []
      }
    }
    Functions: {
      seed_tourney_list: {
        Args: { p_list_id: string; p_days?: number; p_min?: number }
        Returns: number
      }
      materialise_due_schedules: {
        Args: Record<string, never>
        Returns: number
      }
    }
    Enums: {
      inbox_adapter: 'beeper' | 'letspoker'
      inbox_batch_item_status:
        | 'pending'
        | 'approved'
        | 'skipped'
        | 'sending'
        | 'sent'
        | 'failed'
      inbox_batch_status: 'draft' | 'approved' | 'sending' | 'sent' | 'canceled'
      inbox_conversation_type: 'single' | 'group'
      inbox_direction: 'inbound' | 'outbound'
      inbox_draft_status: 'pending' | 'approved' | 'sent' | 'rejected'
      inbox_message_kind: '1to1' | 'batch'
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DefaultSchema = Database['public']

export type Tables<T extends keyof DefaultSchema['Tables']> =
  DefaultSchema['Tables'][T]['Row']
export type TablesInsert<T extends keyof DefaultSchema['Tables']> =
  DefaultSchema['Tables'][T]['Insert']
export type TablesUpdate<T extends keyof DefaultSchema['Tables']> =
  DefaultSchema['Tables'][T]['Update']
export type Enums<T extends keyof DefaultSchema['Enums']> =
  DefaultSchema['Enums'][T]
