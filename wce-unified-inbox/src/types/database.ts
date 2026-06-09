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
          attachment_data: string | null
          attachment_name: string | null
          attachment_mime: string | null
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
          attachment_data?: string | null
          attachment_name?: string | null
          attachment_mime?: string | null
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
          attachment_data?: string | null
          attachment_name?: string | null
          attachment_mime?: string | null
        }
        Relationships: []
      }
      inbox_conversations: {
        Row: {
          account_id: string | null
          adapter: Database['public']['Enums']['inbox_adapter']
          auto_send_enabled: boolean
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
          sender_id: string | null
          sender_name: string | null
          sort_key: string | null
          text: string | null
          timestamp: string
        }
        Insert: {
          adapter_source: Database['public']['Enums']['inbox_adapter']
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
          sender_id?: string | null
          sender_name?: string | null
          sort_key?: string | null
          text?: string | null
          timestamp: string
        }
        Update: {
          adapter_source?: Database['public']['Enums']['inbox_adapter']
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
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
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
