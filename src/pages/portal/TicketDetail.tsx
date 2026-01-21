import React, { useEffect, useState, useRef } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { 
  Loader2, 
  ArrowLeft, 
  Paperclip, 
  Send, 
  Upload, 
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
import PortalLayout from '@/components/portal/PortalLayout';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/integrations/supabase/client';

interface Ticket {
  id: string;
  title: string;
  status: string;
  email_token: string;
  created_at: string;
  updated_at: string;
  last_activity_at: string;
  customer_id: string;
  created_by: string | null;
  customers?: { org_name: string | null; billing_email: string | null };
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

const getStatusBadge = (status: string) => {
  switch (status) {
    case 'submitted':
      return <Badge className="bg-warning/30 text-warning-foreground border-0">Open</Badge>;
    case 'awaiting_response':
      return <Badge className="bg-primary/20 text-primary border-0">Awaiting response</Badge>;
    case 'awaiting_customer':
      return <Badge className="bg-accent/20 text-accent-foreground border-0">Awaiting customer</Badge>;
    case 'closed':
      return <Badge variant="secondary">Closed</Badge>;
    default:
      return <Badge variant="outline">{status}</Badge>;
  }
};

const getAuthorIcon = (authorType: string) => {
  switch (authorType) {
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

const TicketDetail: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const { user, isStaff, customerData, loading } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [ticket, setTicket] = useState<Ticket | null>(null);
  const [comments, setComments] = useState<Comment[]>([]);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [ticketLoading, setTicketLoading] = useState(true);
  
  const [newComment, setNewComment] = useState('');
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [newStatus, setNewStatus] = useState<string>('');

  useEffect(() => {
    if (!loading && !user) {
      navigate('/login');
    }
  }, [user, loading, navigate]);

  useEffect(() => {
    const fetchTicket = async () => {
      if (!id) return;
      setTicketLoading(true);

      try {
        const { data: ticketData, error: ticketError } = await supabase
          .from('tickets')
          .select('*, customers(org_name, billing_email)')
          .eq('id', id)
          .maybeSingle();

        if (ticketError) throw ticketError;
        if (!ticketData) {
          navigate('/portal/tickets');
          return;
        }
        
        setTicket(ticketData);
        setNewStatus(ticketData.status);

        const { data: commentsData, error: commentsError } = await supabase
          .from('ticket_comments')
          .select('*')
          .eq('ticket_id', id)
          .order('created_at', { ascending: true });

        if (commentsError) throw commentsError;
        setComments(commentsData || []);

        const { data: attachmentsData, error: attachmentsError } = await supabase
          .from('ticket_attachments')
          .select('*')
          .eq('ticket_id', id);

        if (attachmentsError) throw attachmentsError;
        setAttachments(attachmentsData || []);
      } catch (error) {
        console.error('Error fetching ticket:', error);
        toast({
          title: 'Error',
          description: 'Failed to load ticket.',
          variant: 'destructive',
        });
      } finally {
        setTicketLoading(false);
      }
    };

    if (!loading) {
      fetchTicket();
    }
  }, [id, loading, navigate, toast]);

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
      // Determine new status based on who's commenting
      let updatedStatus = ticket.status;
      
      if (isStaff) {
        // Staff commenting - if they set a new status, use it; otherwise default to awaiting_customer
        if (newStatus && newStatus !== ticket.status) {
          updatedStatus = newStatus;
        } else if (ticket.status !== 'closed') {
          updatedStatus = 'awaiting_customer';
        }
      } else {
        // Customer commenting
        if (ticket.status === 'closed') {
          updatedStatus = 'awaiting_response'; // Reopen
        } else if (ticket.status !== 'submitted') {
          updatedStatus = 'awaiting_response';
        }
      }

      // Create comment
      const { data: comment, error: commentError } = await supabase
        .from('ticket_comments')
        .insert({
          ticket_id: ticket.id,
          author_user_id: user.id,
          author_email: user.email,
          author_type: isStaff ? 'staff' : 'customer',
          source: 'portal',
          body_markdown: newComment.trim(),
        })
        .select()
        .single();

      if (commentError) throw commentError;

      // Update ticket status
      const { error: updateError } = await supabase
        .from('tickets')
        .update({ status: updatedStatus })
        .eq('id', ticket.id);

      if (updateError) throw updateError;

      // Upload attachments
      const customerId = ticket.customer_id;
      for (const { file } of pendingFiles) {
        const fileName = `${crypto.randomUUID()}-${file.name}`;
        const storagePath = `customer/${customerId}/ticket/${ticket.id}/${fileName}`;

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

      // Send notification
      try {
        await supabase.functions.invoke('ticket-notification', {
          body: {
            ticketId: ticket.id,
            action: 'comment',
            commentId: comment.id,
          },
        });
      } catch (notifyError) {
        console.error('Error sending notification:', notifyError);
      }

      // Update local state
      setComments((prev) => [...prev, comment]);
      setTicket({ ...ticket, status: updatedStatus });
      setNewComment('');
      setPendingFiles([]);
      setNewStatus(updatedStatus);

      toast({
        title: 'Reply sent',
        description: 'Your comment has been added.',
      });
    } catch (error: any) {
      console.error('Error submitting comment:', error);
      toast({
        title: 'Error',
        description: error.message || 'Failed to add comment.',
        variant: 'destructive',
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleCloseTicket = async () => {
    if (!ticket || !isStaff) return;

    try {
      const { error } = await supabase
        .from('tickets')
        .update({ status: 'closed' })
        .eq('id', ticket.id);

      if (error) throw error;

      setTicket({ ...ticket, status: 'closed' });
      setNewStatus('closed');
      toast({
        title: 'Ticket closed',
        description: 'The ticket has been closed.',
      });
    } catch (error: any) {
      toast({
        title: 'Error',
        description: error.message || 'Failed to close ticket.',
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
    if (url) {
      window.open(url, '_blank');
    }
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleString('sv-SE');
  };

  const getAttachmentsForComment = (commentId: string) => {
    return attachments.filter((a) => a.comment_id === commentId);
  };

  if (loading || ticketLoading) {
    return (
      <PortalLayout>
        <div className="flex items-center justify-center min-h-[400px]">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
        </div>
      </PortalLayout>
    );
  }

  if (!ticket) {
    return null;
  }

  return (
    <PortalLayout>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-start gap-4">
          <Button variant="ghost" size="sm" asChild>
            <Link to="/portal/tickets">
              <ArrowLeft className="w-4 h-4 mr-2" />
              Back
            </Link>
          </Button>
        </div>

        <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-4">
          <div>
            <h1 className="text-2xl font-medium">{ticket.title}</h1>
            <p className="text-muted-foreground mt-1">
              Created {formatDate(ticket.created_at)}
              {isStaff && ticket.customers && (
                <> · {ticket.customers.org_name || ticket.customers.billing_email}</>
              )}
            </p>
          </div>
          <div className="flex items-center gap-4">
            {getStatusBadge(ticket.status)}
            {isStaff && ticket.status !== 'closed' && (
              <Button variant="outline" onClick={handleCloseTicket}>
                Close ticket
              </Button>
            )}
          </div>
        </div>

        {/* Comments */}
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
                      <span className="font-medium">
                        {comment.author_email || 'Unknown'}
                      </span>
                      <Badge variant="outline" className="text-xs">
                        {comment.author_type === 'staff' ? 'Staff' : 'Customer'}
                      </Badge>
                      {comment.source === 'email' && (
                        <Badge variant="secondary" className="text-xs">via email</Badge>
                      )}
                      <span className="text-xs text-muted-foreground">
                        {formatDate(comment.created_at)}
                      </span>
                    </div>
                    <div className="prose prose-sm max-w-none text-foreground">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>
                        {comment.body_markdown}
                      </ReactMarkdown>
                    </div>
                    
                    {/* Attachments for this comment */}
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
                            <span className="text-xs text-muted-foreground">
                              ({(attachment.size_bytes / 1024).toFixed(1)} KB)
                            </span>
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
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Add a reply</CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmitComment} className="space-y-4">
              {isStaff && ticket.status !== 'closed' && (
                <div className="space-y-2">
                  <Label>Status after reply</Label>
                  <Select value={newStatus} onValueChange={setNewStatus}>
                    <SelectTrigger className="w-48">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="awaiting_customer">Awaiting customer</SelectItem>
                      <SelectItem value="awaiting_response">Awaiting response</SelectItem>
                      <SelectItem value="closed">Closed</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              )}
              
              <Textarea
                placeholder="Write your reply... Markdown is supported."
                value={newComment}
                onChange={(e) => setNewComment(e.target.value)}
                className="min-h-[120px]"
              />

              <div className="flex items-center gap-4">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <Paperclip className="w-4 h-4 mr-2" />
                  Attach files
                </Button>
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  onChange={handleFileSelect}
                  className="hidden"
                  accept="image/*,text/plain,application/pdf,application/zip,application/gzip,application/json"
                />
              </div>

              {pendingFiles.length > 0 && (
                <div className="space-y-2">
                  {pendingFiles.map(({ file, id: fileId }) => (
                    <div
                      key={fileId}
                      className="flex items-center justify-between p-2 bg-muted rounded"
                    >
                      <div className="flex items-center gap-2">
                        <File className="w-4 h-4 text-muted-foreground" />
                        <span className="text-sm truncate max-w-xs">{file.name}</span>
                        <span className="text-xs text-muted-foreground">
                          ({(file.size / 1024).toFixed(1)} KB)
                        </span>
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => removeFile(fileId)}
                      >
                        <X className="w-4 h-4" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}

              <div className="flex justify-end">
                <Button type="submit" disabled={isSubmitting || !newComment.trim()}>
                  {isSubmitting ? (
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  ) : (
                    <Send className="w-4 h-4 mr-2" />
                  )}
                  Send reply
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      </div>
    </PortalLayout>
  );
};

export default TicketDetail;
