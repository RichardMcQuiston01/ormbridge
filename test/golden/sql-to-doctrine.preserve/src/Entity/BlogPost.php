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
    #[ORM\GeneratedValue(strategy: 'AUTO')]
    #[ORM\Column(name: 'id', type: 'integer')]
    private ?int $id = null;

    #[ORM\Column(
        name: 'created_at',
        type: 'datetimetz_immutable',
        options: ['default' => 'CURRENT_TIMESTAMP'],
    )]
    private DateTimeImmutable $created_at;

    #[ORM\Column(name: 'updated_at', type: 'datetimetz_immutable')]
    private DateTimeImmutable $updated_at;

    #[ORM\Column(name: 'public_id', type: 'guid', unique: true)]
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

    #[ORM\ManyToOne(targetEntity: BlogUser::class, inversedBy: 'author_blog_posts')]
    #[ORM\JoinColumn(
        name: 'author_id',
        referencedColumnName: 'id',
        nullable: false,
        onDelete: 'CASCADE',
    )]
    private BlogUser $author;

    #[ORM\ManyToOne(targetEntity: BlogUser::class, inversedBy: 'editor_blog_posts')]
    #[ORM\JoinColumn(
        name: 'editor_id',
        referencedColumnName: 'id',
        nullable: true,
        onDelete: 'SET NULL',
    )]
    private ?BlogUser $editor = null;

    #[ORM\ManyToOne(targetEntity: BlogCategory::class, inversedBy: 'blog_posts')]
    #[ORM\JoinColumn(
        name: 'category_id',
        referencedColumnName: 'id',
        nullable: false,
        onDelete: 'RESTRICT',
    )]
    private BlogCategory $category;

    /** @var Collection<int, BlogTag> */
    #[ORM\ManyToMany(targetEntity: BlogTag::class, inversedBy: 'blog_posts')]
    #[ORM\JoinTable(name: 'blog_post_tags')]
    #[ORM\JoinColumn(name: 'blog_post_id', referencedColumnName: 'id', onDelete: 'CASCADE')]
    #[ORM\InverseJoinColumn(name: 'blog_tag_id', referencedColumnName: 'id', onDelete: 'CASCADE')]
    private Collection $tags;

    public function __construct()
    {
        $this->created_at = new DateTimeImmutable();
        $this->public_id = self::generateUuid();
        $this->published_at = new DateTimeImmutable();
        $this->tags = new ArrayCollection();
    }

    public function getId(): ?int
    {
        return $this->id;
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
