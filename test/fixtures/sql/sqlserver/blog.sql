-- The canonical blog schema as SQL Server (T-SQL) DDL.
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO

CREATE TABLE [dbo].[blog_user] (
    [id] INT IDENTITY(1,1) NOT NULL,
    CONSTRAINT [PK_blog_user] PRIMARY KEY CLUSTERED ([id] ASC)
)
GO

CREATE TABLE [dbo].[blog_category] (
    [id] INT IDENTITY(1,1) NOT NULL,
    [created_at] DATETIME2(7) NOT NULL CONSTRAINT [DF_blog_category_created_at] DEFAULT (SYSUTCDATETIME()),
    [updated_at] DATETIME2(7) NOT NULL,
    [name] NVARCHAR(100) NOT NULL,
    [slug] NVARCHAR(50) NOT NULL,
    [parent_id] INT NULL,
    CONSTRAINT [PK_blog_category] PRIMARY KEY CLUSTERED ([id] ASC),
    CONSTRAINT [UQ_blog_category_name] UNIQUE NONCLUSTERED ([name] ASC),
    CONSTRAINT [FK_blog_category_parent] FOREIGN KEY ([parent_id]) REFERENCES [dbo].[blog_category] ([id]) ON DELETE SET NULL
)
GO

CREATE TABLE [dbo].[blog_tag] (
    [id] INT IDENTITY(1,1) NOT NULL,
    [label] NVARCHAR(50) NOT NULL,
    CONSTRAINT [PK_blog_tag] PRIMARY KEY CLUSTERED ([id] ASC)
)
GO

CREATE TABLE [dbo].[blog_post] (
    [id] INT IDENTITY(1,1) NOT NULL,
    [created_at] DATETIME2(7) NOT NULL CONSTRAINT [DF_blog_post_created_at] DEFAULT (SYSUTCDATETIME()),
    [updated_at] DATETIME2(7) NOT NULL,
    [public_id] UNIQUEIDENTIFIER NOT NULL CONSTRAINT [DF_blog_post_public_id] DEFAULT (NEWID()),
    [title] NVARCHAR(200) NOT NULL,
    [body] NVARCHAR(MAX) NOT NULL,
    [status] NVARCHAR(20) NOT NULL CONSTRAINT [DF_blog_post_status] DEFAULT ('draft'),
    [rating] DECIMAL(4, 2) NULL,
    [view_count] INT NOT NULL CONSTRAINT [DF_blog_post_view_count] DEFAULT ((0)),
    [is_featured] BIT NOT NULL CONSTRAINT [DF_blog_post_is_featured] DEFAULT ((0)),
    [published_at] DATETIME2(7) NOT NULL CONSTRAINT [DF_blog_post_published_at] DEFAULT (SYSUTCDATETIME()),
    [metadata] NVARCHAR(MAX) NOT NULL CONSTRAINT [DF_blog_post_metadata] DEFAULT ('{}'),
    [author_id] INT NOT NULL,
    [editor_id] INT NULL,
    [category_id] INT NOT NULL,
    CONSTRAINT [PK_blog_post] PRIMARY KEY CLUSTERED ([id] ASC),
    CONSTRAINT [UQ_blog_post_public_id] UNIQUE NONCLUSTERED ([public_id]),
    CONSTRAINT [UQ_blog_post_author_title] UNIQUE NONCLUSTERED ([author_id], [title]),
    CONSTRAINT [CK_blog_post_status] CHECK ([status] IN ('draft', 'published'))
)
GO

ALTER TABLE [dbo].[blog_post] WITH CHECK ADD CONSTRAINT [FK_blog_post_author] FOREIGN KEY ([author_id]) REFERENCES [dbo].[blog_user] ([id]) ON DELETE CASCADE
GO
ALTER TABLE [dbo].[blog_post] WITH CHECK ADD CONSTRAINT [FK_blog_post_editor] FOREIGN KEY ([editor_id]) REFERENCES [dbo].[blog_user] ([id]) ON DELETE SET NULL
GO
ALTER TABLE [dbo].[blog_post] WITH CHECK ADD CONSTRAINT [FK_blog_post_category] FOREIGN KEY ([category_id]) REFERENCES [dbo].[blog_category] ([id])
GO
ALTER TABLE [dbo].[blog_post] CHECK CONSTRAINT [FK_blog_post_author]
GO

CREATE NONCLUSTERED INDEX [blog_post_title_idx] ON [dbo].[blog_post] ([title] ASC)
GO
CREATE NONCLUSTERED INDEX [post_pub_status_idx] ON [dbo].[blog_post] ([published_at] ASC, [status] ASC)
GO

CREATE TABLE [dbo].[blog_profile] (
    [id] INT IDENTITY(1,1) NOT NULL,
    [bio] NVARCHAR(MAX) NULL,
    [avatar] NVARCHAR(100) NULL,
    [user_id] INT NOT NULL,
    CONSTRAINT [PK_blog_profile] PRIMARY KEY CLUSTERED ([id] ASC),
    CONSTRAINT [UQ_blog_profile_user] UNIQUE NONCLUSTERED ([user_id]),
    CONSTRAINT [FK_blog_profile_user] FOREIGN KEY ([user_id]) REFERENCES [dbo].[blog_user] ([id]) ON DELETE CASCADE
)
GO

CREATE TABLE [dbo].[blog_post_tags] (
    [post_id] INT NOT NULL,
    [tag_id] INT NOT NULL,
    CONSTRAINT [PK_blog_post_tags] PRIMARY KEY CLUSTERED ([post_id] ASC, [tag_id] ASC),
    CONSTRAINT [FK_blog_post_tags_post] FOREIGN KEY ([post_id]) REFERENCES [dbo].[blog_post] ([id]) ON DELETE CASCADE,
    CONSTRAINT [FK_blog_post_tags_tag] FOREIGN KEY ([tag_id]) REFERENCES [dbo].[blog_tag] ([id]) ON DELETE CASCADE
)
GO
