import React, { useEffect, useState, useRef } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { 
  Loader2, 
  ArrowLeft, 
  Paperclip, 
  Send, 
  X, 
  File, 
  Download,
  User,
  Headphones,
  Bot
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { useToast } from '@/hooks/use-toast';
import SubscriptionRequiredAlert from '@/components/portal/SubscriptionRequiredAlert';
import { useAuth } from '@/contexts/AuthContext';
import { useLanguage } from '@/contexts/LanguageContext';
import { useSubscription } from '@/hooks/use-subscription';
import { supabase } from '@/integrations/supabase/client';

interface Ticket {
  id: string;
  ticket_number: string;
  title: string;
  status: string;
  email_token: string;
  created_at: string;
  updated_at: string;
  last_activity_at: string;
  customer_id: string;
  created_by: string | null;
  customers?: { name: string | null; billing_email: string | null; contact_name: string | null; contact_email: string | null };
}

interface Comment {
  id: string;
  ticket_id: string;
  author_user_id: string | null;
  author_email: string | null;
  author_type: string;
  source: string;
  body_markdown: string;
  created_at: string;
}

interface Attachment {
  id: string;
  ticket_id: string;
  comment_id: string | null;
  storage_path: string;
  filename: string;
  content_type: string;
  size_bytes: number;
}

interface PendingFile {
  file: File;
  id: string;
}

interface TicketDetailProps {
  customerId?: string;
  isStaffView?: boolean;
}

const TicketDetail: React.FC<TicketDetailProps> = ({ customerId: propCustomerId, isStaffView = false }) => {
  const { ticketNumber } = useParams<{ ticketNumber: string }>();
  const { user, isStaff, customerData, loading } = useAuth();
  const { isSubscribed, loading: subscriptionLoading } = useSubscription();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { t } = useLanguage();
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Determine the effective role for this view
  const effectiveIsStaff = isStaffView || isStaff;
  const authorType = effectiveIsStaff ? 'staff' : 'customer';
  // Default status after reply: opposite of the logged-in user's role
  const defaultStatusAfterReply = effectiveIsStaff ? 'awaiting_customer' : 'awaiting_response';

  const [ticket, setTicket] = useState<Ticket | null>(null);
  const [comments, setComments] = useState<Comment[]>([]);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [ticketLoading, setTicketLoading] = useState(true);
  
  const [newComment, setNewComment] = useState('');
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [newStatus, setNewStatus] = useState<string>('');

  // Back link destination
  const backLink = isStaffView && propCustomerId
    ? `/portal/customers/${propCustomerId}/tickets`
    : '/portal/tickets';

  const getStatusBadge = (status: string) => {
    const statusLabels: Record<string, string> = {
      submitted: t('Öppen', 'Open'),
      awaiting_response: t('Väntar på personal', 'Awaiting staff'),
      awaiting_customer: t('Väntar på kund', 'Awaiting customer'),
      closed: t('Stängd', 'Closed'),
    };
    const label = statusLabels[status] || status;

    switch (status) {
      case 'submitted':
        return <Badge className="bg-warning/30 text-warning-foreground border-0">{label}</Badge>;
      case 'awaiting_response':
        return <Badge className="bg-primary/20 text-primary border-0">{label}</Badge>;
      case 'awaiting_customer':
        return <Badge className="bg-accent/20 text-accent-foreground border-0">{label}</Badge>;
      case 'closed':
        return <Badge variant="secondary">{label}</Badge>;
      default:
        return <Badge variant="outline">{label}</Badge>;
    }
  };

  const getAuthorIcon = (aType: string) => {
    switch (aType) {
      case 'customer':
        return <User className="w-4 h-4" />;
      case 'staff':
        return <Headphones className="w-4 h-4" />;
      case 'system':
        return <Bot className="w-4 h-4" />;
      default:
        return <User className="w-4 h-4" />;
    }
  };

  useEffect(() => {
    if (!loading && !user) {
      navigate('/login');
    }
  }, [user, loading, navigate]);

  useEffect(() => {
    const fetchTicket = async () => {
      if (!ticketNumber) return;
      setTicketLoading(true);

      try {
        let query = supabase
          .from('tickets')
          .select('*, customers:customers_with_identity!tickets_customer_id_fkey(name, billing_email, contact_name, contact_email)')
          .eq('ticket_number', ticketNumber);

        // Scope to customer if viewing as staff for a specific customer
        if (isStaffView && propCustomerId) {
          query = query.eq('customer_id', propCustomerId);
        }

        const { data: ticketData, error: ticketError } = await query.maybeSingle();

        if (ticketError) throw ticketError;
        if (!ticketData) {
          navigate(backLink);
          return;
        }
        
        setTicket(ticketData);
        // Set default status: if closed keep closed, otherwise use role-appropriate default
        setNewStatus(ticketData.status === 'closed' ? 'closed' : defaultStatusAfterReply);

        const { data: commentsData, error: commentsError } = await supabase
          .from('ticket_comments')
          .select('*')
          .eq('ticket_id', ticketData.id)
          .order('created_at', { ascending: true });

        if (commentsError) throw commentsError;
        setComments(commentsData || []);

        const { data: attachmentsData, error: attachmentsError } = await supabase
          .from('ticket_attachments')
          .select('*')
          .eq('ticket_id', ticketData.id);

        if (attachmentsError) throw attachmentsError;
        setAttachments(attachmentsData || []);
      } catch (error) {
        console.error('Error fetching ticket:', error);
        toast({
          title: t('Fel', 'Error'),
          description: t('Det gick inte att ladda ärendet.', 'Failed to load ticket.'),
          variant: 'destructive',
        });
      } finally {
        setTicketLoading(false);
      }
    };

    if (!loading) {
      fetchTicket();
    }
  }, [ticketNumber, propCustomerId, isStaffView, loading, navigate, toast, t, backLink, defaultStatusAfterReply]);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    const newFiles = files.map((file) => ({
      file,
      id: crypto.randomUUID(),
    }));
    setPendingFiles((prev) => [...prev, ...newFiles]);
    
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const removeFile = (fileId: string) => {
    setPendingFiles((prev) => prev.filter((f) => f.id !== fileId));
  };

  const handleSubmitComment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user || !ticket || !newComment.trim()) return;

    setIsSubmitting(true);

    try {
      let updatedStatus = ticket.status;
      
      if (effectiveIsStaff) {
        // Staff: use the selected status, or default to awaiting_customer
        if (newStatus && newStatus !== ticket.status) {
          updatedStatus = newStatus;
        } else if (ticket.status !== 'closed') {
          updatedStatus = 'awaiting_customer';
        }
      } else {
        // Customer: always set to awaiting_response (unless closed)
        if (ticket.status === 'closed') {
          updatedStatus = 'awaiting_response';
        } else if (ticket.status !== 'submitted') {
          updatedStatus = 'awaiting_response';
        }
      }

      const { data: comment, error: commentError } = await supabase
        .from('ticket_comments')
        .insert({
          ticket_id: ticket.id,
          author_user_id: user.id,
          author_email: user.email,
          author_type: authorType,
          source: 'portal',
          body_markdown: newComment.trim(),
        })
        .select()
        .single();

      if (commentError) throw commentError;

      const { error: updateError } = await supabase
        .from('tickets')
        .update({ status: updatedStatus })
        .eq('id', ticket.id);

      if (updateError) throw updateError;

      const ticketCustomerId = ticket.customer_id;
      for (const { file } of pendingFiles) {
        const fileName = `${crypto.randomUUID()}-${file.name}`;
        const storagePath = `customer/${ticketCustomerId}/ticket/${ticket.id}/${fileName}`;

        const { error: uploadError } = await supabase.storage
          .from('ticket-attachments')
          .upload(storagePath, file);

        if (uploadError) {
          console.error('Error uploading file:', uploadError);
          continue;
        }

        const { data: attachmentData } = await supabase
          .from('ticket_attachments')
          .insert({
            ticket_id: ticket.id,
            comment_id: comment.id,
            storage_path: storagePath,
            filename: file.name,
            content_type: file.type,
            size_bytes: file.size,
          })
          .select()
          .single();

        if (attachmentData) {
          setAttachments((prev) => [...prev, attachmentData]);
        }
      }

      try {
        await supabase.functions.invoke('ticket-notification', {
          body: { ticketId: ticket.id, action: 'comment', commentId: comment.id },
        });
      } catch (notifyError) {
        console.error('Error sending notification:', notifyError);
      }

      setComments((prev) => [...prev, comment]);
      setTicket({ ...ticket, status: updatedStatus });
      setNewComment('');
      setPendingFiles([]);
      setNewStatus(updatedStatus);

      toast({
        title: t('Svar skickat', 'Reply sent'),
        description: t('Din kommentar har lagts till.', 'Your comment has been added.'),
      });
    } catch (error: any) {
      console.error('Error submitting comment:', error);
      toast({
        title: t('Fel', 'Error'),
        description: error.message || t('Det gick inte att lägga till kommentaren.', 'Failed to add comment.'),
        variant: 'destructive',
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleCloseTicket = async () => {
    if (!ticket) return;

    try {
      const { error } = await supabase
        .from('tickets')
        .update({ status: 'closed' })
        .eq('id', ticket.id);

      if (error) throw error;

      setTicket({ ...ticket, status: 'closed' });
      setNewStatus('closed');
      toast({
        title: t('Ärende stängt', 'Ticket closed'),
        description: t('Ärendet har stängts.', 'The ticket has been closed.'),
      });
    } catch (error: any) {
      toast({
        title: t('Fel', 'Error'),
        description: error.message || t('Det gick inte att stänga ärendet.', 'Failed to close ticket.'),
        variant: 'destructive',
      });
    }
  };

  const getAttachmentUrl = async (storagePath: string) => {
    const { data } = await supabase.storage
      .from('ticket-attachments')
      .createSignedUrl(storagePath, 3600);
    return data?.signedUrl;
  };

  const handleDownloadAttachment = async (attachment: Attachment) => {
    const url = await getAttachmentUrl(attachment.storage_path);
    if (url) window.open(url, '_blank');
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleString('sv-SE');
  };

  const getAttachmentsForComment = (commentId: string) => {
    return attachments.filter((a) => a.comment_id === commentId);
  };


  if (loading || ticketLoading) {
    return (
      <>
        <div className="flex items-center justify-center min-h-[400px]">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
        </div>
      </>
    );
  }

  if (!ticket) return null;

  // Determine if reply form should be gated behind subscription (customer only)
  const showSubscriptionGate = !effectiveIsStaff && !subscriptionLoading && !isSubscribed;

  return (
    <>
      <div className="space-y-6">
        <div className="flex items-start gap-4">
          <Button variant="ghost" size="sm" asChild>
            <Link to={backLink}>
              <ArrowLeft className="w-4 h-4 mr-2" />
              {t('Tillbaka', 'Back')}
            </Link>
          </Button>
        </div>

        <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-4">
          <div>
            <div className="flex items-center gap-3 mb-1">
              <span className="text-muted-foreground font-medium">{ticket.ticket_number}</span>
            </div>
            <h1 className="text-2xl font-medium">{ticket.title}</h1>
            <p className="text-muted-foreground mt-1">
              {t('Skapad', 'Created')} {formatDate(ticket.created_at)}
              {effectiveIsStaff && ticket.customers && (
                <> · {ticket.customers.name || ticket.customers.contact_name || ticket.customers.contact_email || ticket.customers.billing_email}</>
              )}
            </p>
          </div>
          <div className="flex items-center gap-4">
            {getStatusBadge(ticket.status)}
            {ticket.status !== 'closed' && (
              <Button variant="outline" onClick={handleCloseTicket}>
                {t('Stäng ärende', 'Close ticket')}
              </Button>
            )}
          </div>
        </div>

        <Card>
          <CardContent className="pt-6 space-y-6">
            {comments.map((comment, index) => (
              <div key={comment.id}>
                {index > 0 && <Separator className="my-6" />}
                <div className="flex gap-4">
                  <div className={`w-8 h-8 rounded-full flex items-center justify-center ${
                    comment.author_type === 'staff' 
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-muted text-muted-foreground'
                  }`}>
                    {getAuthorIcon(comment.author_type)}
                  </div>
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-2">
                      <span className="font-medium">{comment.author_email || t('Okänd', 'Unknown')}</span>
                      <Badge variant="outline" className="text-xs">
                        {comment.author_type === 'staff' ? t('Personal', 'Staff') : t('Kund', 'Customer')}
                      </Badge>
                      {comment.source === 'email' && (
                        <Badge variant="secondary" className="text-xs">{t('via e-post', 'via email')}</Badge>
                      )}
                      <span className="text-xs text-muted-foreground">{formatDate(comment.created_at)}</span>
                    </div>
                    <div className="prose prose-sm max-w-none text-foreground">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{comment.body_markdown}</ReactMarkdown>
                    </div>
                    {getAttachmentsForComment(comment.id).length > 0 && (
                      <div className="mt-4 space-y-2">
                        {getAttachmentsForComment(comment.id).map((attachment) => (
                          <button
                            key={attachment.id}
                            onClick={() => handleDownloadAttachment(attachment)}
                            className="flex items-center gap-2 p-2 bg-muted rounded hover:bg-muted/80 transition-colors text-left"
                          >
                            <File className="w-4 h-4 text-muted-foreground" />
                            <span className="text-sm">{attachment.filename}</span>
                            <span className="text-xs text-muted-foreground">({(attachment.size_bytes / 1024).toFixed(1)} KB)</span>
                            <Download className="w-4 h-4 text-muted-foreground ml-auto" />
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>

        {/* Reply form */}
        {showSubscriptionGate ? (
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">{t('Lägg till svar', 'Add a reply')}</CardTitle>
            </CardHeader>
            <CardContent>
              <SubscriptionRequiredAlert />
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">{t('Lägg till svar', 'Add a reply')}</CardTitle>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleSubmitComment} className="space-y-4">
                {effectiveIsStaff && ticket.status !== 'closed' && (
                  <div className="space-y-2">
                    <Label>{t('Status efter svar', 'Status after reply')}</Label>
                    <Select value={newStatus} onValueChange={setNewStatus}>
                      <SelectTrigger className="w-48">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="awaiting_customer">{t('Väntar på kund', 'Awaiting customer')}</SelectItem>
                        <SelectItem value="awaiting_response">{t('Väntar på personal', 'Awaiting staff')}</SelectItem>
                        <SelectItem value="closed">{t('Stängd', 'Closed')}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                )}
                
                <Textarea
                  placeholder={t('Skriv ditt svar... Markdown stöds.', 'Write your reply... Markdown is supported.')}
                  value={newComment}
                  onChange={(e) => setNewComment(e.target.value)}
                  className="min-h-[120px]"
                />

                <div className="flex items-center gap-4">
                  <Button type="button" variant="outline" onClick={() => fileInputRef.current?.click()}>
                    <Paperclip className="w-4 h-4 mr-2" />
                    {t('Bifoga filer', 'Attach files')}
                  </Button>
                  <input ref={fileInputRef} type="file" multiple onChange={handleFileSelect} className="hidden" accept="image/*,text/plain,application/pdf,application/zip,application/gzip,application/json" />
                </div>

                {pendingFiles.length > 0 && (
                  <div className="space-y-2">
                    {pendingFiles.map(({ file, id: fileId }) => (
                      <div key={fileId} className="flex items-center justify-between p-2 bg-muted rounded">
                        <div className="flex items-center gap-2">
                          <File className="w-4 h-4 text-muted-foreground" />
                          <span className="text-sm truncate max-w-xs">{file.name}</span>
                          <span className="text-xs text-muted-foreground">({(file.size / 1024).toFixed(1)} KB)</span>
                        </div>
                        <Button type="button" variant="ghost" size="sm" onClick={() => removeFile(fileId)}>
                          <X className="w-4 h-4" />
                        </Button>
                      </div>
                    ))}
                  </div>
                )}

                <div className="flex justify-end">
                  <Button type="submit" disabled={isSubmitting || !newComment.trim()}>
                    {isSubmitting ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Send className="w-4 h-4 mr-2" />}
                    {t('Skicka svar', 'Send reply')}
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>
        )}
      </div>
    </>
  );
};

export default TicketDetail;
