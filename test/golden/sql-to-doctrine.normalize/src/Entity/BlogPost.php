<?php

declare(strict_types=1);

namespace App\Entity;

use App\Enum\PostStatus;
use DateTimeImmutable;
use Doctrine\Common\Collections\ArrayCollection;
use Doctrine\Common\Collections\Collection;
use Doctrine\ORM\Mapping as ORM;

#[ORM\Entity]
#[ORM\Table(name: 'blog_post')]
#[ORM\UniqueConstraint(name: 'blog_post_author_id_title_key', columns: ['author_id', 'title'])]
#[ORM\Index(name: 'blog_post_title_idx', columns: ['title'])]
#[ORM\Index(name: 'post_pub_status_idx', columns: ['published_at', 'status'])]
class BlogPost
{
    #[ORM\Id]
    #[ORM\Column(name: 'id', type: 'guid')]
    private string $id;

    #[ORM\Column(
        name: 'created_at',
        type: 'datetimetz_immutable',
        options: ['default' => 'CURRENT_TIMESTAMP'],
    )]
    private DateTimeImmutable $createdAt;

    #[ORM\Column(name: 'updated_at', type: 'datetimetz_immutable')]
    private DateTimeImmutable $updatedAt;

    #[ORM\Column(name: 'public_id', type: 'guid', unique: true)]
    private string $publicId;

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
    private int $viewCount = 0;

    #[ORM\Column(name: 'is_featured', type: 'boolean', options: ['default' => false])]
    private bool $isFeatured = false;

    #[ORM\Column(
        name: 'published_at',
        type: 'datetimetz_immutable',
        options: ['default' => 'CURRENT_TIMESTAMP'],
    )]
    private DateTimeImmutable $publishedAt;

    #[ORM\Column(name: 'metadata', type: 'json', options: ['jsonb' => true])]
    private mixed $metadata = [];

    #[ORM\ManyToOne(targetEntity: BlogUser::class, inversedBy: 'authorBlogPosts')]
    #[ORM\JoinColumn(
        name: 'author_id',
        referencedColumnName: 'id',
        nullable: false,
        onDelete: 'CASCADE',
    )]
    private BlogUser $author;

    #[ORM\ManyToOne(targetEntity: BlogUser::class, inversedBy: 'editorBlogPosts')]
    #[ORM\JoinColumn(
        name: 'editor_id',
        referencedColumnName: 'id',
        nullable: true,
        onDelete: 'SET NULL',
    )]
    private ?BlogUser $editor = null;

    #[ORM\ManyToOne(targetEntity: BlogCategory::class, inversedBy: 'blogPosts')]
    #[ORM\JoinColumn(
        name: 'category_id',
        referencedColumnName: 'id',
        nullable: false,
        onDelete: 'RESTRICT',
    )]
    private BlogCategory $category;

    /** @var Collection<int, BlogTag> */
    #[ORM\ManyToMany(targetEntity: BlogTag::class, inversedBy: 'blogPosts')]
    #[ORM\JoinTable(name: 'blog_post_tags')]
    #[ORM\JoinColumn(name: 'blog_post_id', referencedColumnName: 'id', onDelete: 'CASCADE')]
    #[ORM\InverseJoinColumn(name: 'blog_tag_id', referencedColumnName: 'id', onDelete: 'CASCADE')]
    private Collection $tags;

    public function __construct()
    {
        $this->id = self::generateUuid();
        $this->createdAt = new DateTimeImmutable();
        $this->publicId = self::generateUuid();
        $this->publishedAt = new DateTimeImmutable();
        $this->tags = new ArrayCollection();
    }

    public function getId(): string
    {
        return $this->id;
    }

    public function setId(string $id): static
    {
        $this->id = $id;

        return $this;
    }

    public function getCreatedAt(): DateTimeImmutable
    {
        return $this->createdAt;
    }

    public function setCreatedAt(DateTimeImmutable $createdAt): static
    {
        $this->createdAt = $createdAt;

        return $this;
    }

    public function getUpdatedAt(): DateTimeImmutable
    {
        return $this->updatedAt;
    }

    public function setUpdatedAt(DateTimeImmutable $updatedAt): static
    {
        $this->updatedAt = $updatedAt;

        return $this;
    }

    public function getPublicId(): string
    {
        return $this->publicId;
    }

    public function setPublicId(string $publicId): static
    {
        $this->publicId = $publicId;

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
        return $this->viewCount;
    }

    public function setViewCount(int $viewCount): static
    {
        $this->viewCount = $viewCount;

        return $this;
    }

    public function isFeatured(): bool
    {
        return $this->isFeatured;
    }

    public function setIsFeatured(bool $isFeatured): static
    {
        $this->isFeatured = $isFeatured;

        return $this;
    }

    public function getPublishedAt(): DateTimeImmutable
    {
        return $this->publishedAt;
    }

    public function setPublishedAt(DateTimeImmutable $publishedAt): static
    {
        $this->publishedAt = $publishedAt;

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

    public function getAuthor(): BlogUser
    {
        return $this->author;
    }

    public function setAuthor(BlogUser $author): static
    {
        $this->author = $author;

        return $this;
    }

    public function getEditor(): ?BlogUser
    {
        return $this->editor;
    }

    public function setEditor(?BlogUser $editor): static
    {
        $this->editor = $editor;

        return $this;
    }

    public function getCategory(): BlogCategory
    {
        return $this->category;
    }

    public function setCategory(BlogCategory $category): static
    {
        $this->category = $category;

        return $this;
    }

    /**
     * @return Collection<int, BlogTag>
     */
    public function getTags(): Collection
    {
        return $this->tags;
    }

    public function addTag(BlogTag $tag): static
    {
        if (!$this->tags->contains($tag)) {
            $this->tags->add($tag);
            $tag->addBlogPost($this);
        }

        return $this;
    }

    public function removeTag(BlogTag $tag): static
    {
        if ($this->tags->removeElement($tag)) {
            $tag->removeBlogPost($this);
        }

        return $this;
    }

    private static function generateUuid(): string
    {
        $bytes = random_bytes(16);
        $bytes[6] = chr((ord($bytes[6]) & 0x0f) | 0x40);
        $bytes[8] = chr((ord($bytes[8]) & 0x3f) | 0x80);

        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($bytes), 4));
    }
}
