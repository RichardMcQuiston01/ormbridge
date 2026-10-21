<?php

declare(strict_types=1);

namespace App\Entity;

use App\Enum\PostStatus;
use DateTimeImmutable;
use Doctrine\ORM\Mapping as ORM;

#[ORM\Entity]
#[ORM\Table(name: 'Post')]
class Post
{
    #[ORM\Id]
    #[ORM\Column(name: 'id', type: 'integer')]
    private int $id;

    #[ORM\Column(
        name: 'created_at',
        type: 'datetimetz_immutable',
        options: ['default' => 'CURRENT_TIMESTAMP'],
    )]
    private DateTimeImmutable $created_at;

    #[ORM\Column(name: 'updated_at', type: 'datetimetz_immutable')]
    private DateTimeImmutable $updated_at;

    #[ORM\Column(name: 'public_id', type: 'guid')]
    private string $public_id;

    #[ORM\Column(name: 'title', type: 'string', length: 200)]
    private string $title;

    #[ORM\Column(name: 'body', type: 'text')]
    private string $body;

    #[ORM\Column(
        name: 'status',
        type: 'string',
        enumType: PostStatus::class,
        options: ['default' => 'draft'],
    )]
    private PostStatus $status = PostStatus::DRAFT;

    #[ORM\Column(name: 'rating', type: 'decimal', precision: 4, scale: 2, nullable: true)]
    private ?string $rating = null;

    #[ORM\Column(name: 'view_count', type: 'integer', options: ['default' => 0])]
    private int $view_count = 0;

    #[ORM\Column(name: 'is_featured', type: 'boolean', options: ['default' => false])]
    private bool $is_featured = false;

    #[ORM\Column(
        name: 'published_at',
        type: 'datetimetz_immutable',
        options: ['default' => 'CURRENT_TIMESTAMP'],
    )]
    private DateTimeImmutable $published_at;

    #[ORM\Column(name: 'metadata', type: 'json', options: ['jsonb' => true])]
    private mixed $metadata = [];

    #[ORM\Column(name: 'author_id', type: 'integer')]
    private int $author_id;

    #[ORM\Column(name: 'editor_id', type: 'integer', nullable: true)]
    private ?int $editor_id = null;

    #[ORM\Column(name: 'category_id', type: 'integer')]
    private int $category_id;

    public function __construct()
    {
        $this->created_at = new DateTimeImmutable();
        $this->published_at = new DateTimeImmutable();
    }

    public function getId(): int
    {
        return $this->id;
    }

    public function setId(int $id): static
    {
        $this->id = $id;

        return $this;
    }

    public function getCreatedAt(): DateTimeImmutable
    {
        return $this->created_at;
    }

    public function setCreatedAt(DateTimeImmutable $createdAt): static
    {
        $this->created_at = $createdAt;

        return $this;
    }

    public function getUpdatedAt(): DateTimeImmutable
    {
        return $this->updated_at;
    }

    public function setUpdatedAt(DateTimeImmutable $updatedAt): static
    {
        $this->updated_at = $updatedAt;

        return $this;
    }

    public function getPublicId(): string
    {
        return $this->public_id;
    }

    public function setPublicId(string $publicId): static
    {
        $this->public_id = $publicId;

        return $this;
    }

    public function getTitle(): string
    {
        return $this->title;
    }

    public function setTitle(string $title): static
    {
        $this->title = $title;

        return $this;
    }

    public function getBody(): string
    {
        return $this->body;
    }

    public function setBody(string $body): static
    {
        $this->body = $body;

        return $this;
    }

    public function getStatus(): PostStatus
    {
        return $this->status;
    }

    public function setStatus(PostStatus $status): static
    {
        $this->status = $status;

        return $this;
    }

    public function getRating(): ?string
    {
        return $this->rating;
    }

    public function setRating(?string $rating): static
    {
        $this->rating = $rating;

        return $this;
    }

    public function getViewCount(): int
    {
        return $this->view_count;
    }

    public function setViewCount(int $viewCount): static
    {
        $this->view_count = $viewCount;

        return $this;
    }

    public function isFeatured(): bool
    {
        return $this->is_featured;
    }

    public function setIsFeatured(bool $isFeatured): static
    {
        $this->is_featured = $isFeatured;

        return $this;
    }

    public function getPublishedAt(): DateTimeImmutable
    {
        return $this->published_at;
    }

    public function setPublishedAt(DateTimeImmutable $publishedAt): static
    {
        $this->published_at = $publishedAt;

        return $this;
    }

    public function getMetadata(): mixed
    {
        return $this->metadata;
    }

    public function setMetadata(mixed $metadata): static
    {
        $this->metadata = $metadata;

        return $this;
    }

    public function getAuthorId(): int
    {
        return $this->author_id;
    }

    public function setAuthorId(int $authorId): static
    {
        $this->author_id = $authorId;

        return $this;
    }

    public function getEditorId(): ?int
    {
        return $this->editor_id;
    }

    public function setEditorId(?int $editorId): static
    {
        $this->editor_id = $editorId;

        return $this;
    }

    public function getCategoryId(): int
    {
        return $this->category_id;
    }

    public function setCategoryId(int $categoryId): static
    {
        $this->category_id = $categoryId;

        return $this;
    }
}
