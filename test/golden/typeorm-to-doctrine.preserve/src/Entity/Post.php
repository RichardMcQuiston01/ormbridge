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
#[ORM\UniqueConstraint(columns: ['author_id', 'title'])]
#[ORM\Index(name: 'post_pub_status_idx', columns: ['published_at', 'status'])]
#[ORM\Index(columns: ['title'])]
#[ORM\HasLifecycleCallbacks]
class Post
{
    #[ORM\Column(
        name: 'created_at',
        type: 'datetimetz_immutable',
        options: ['default' => 'CURRENT_TIMESTAMP'],
    )]
    private DateTimeImmutable $createdAt;

    #[ORM\Column(name: 'updated_at', type: 'datetimetz_immutable')]
    private DateTimeImmutable $updatedAt;

    #[ORM\Id]
    #[ORM\GeneratedValue(strategy: 'AUTO')]
    #[ORM\Column(name: 'id', type: 'integer')]
    private ?int $id = null;

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
    private PostStatus $status = PostStatus::Draft;

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

    #[ORM\ManyToOne(targetEntity: User::class, inversedBy: 'posts')]
    #[ORM\JoinColumn(
        name: 'author_id',
        referencedColumnName: 'id',
        nullable: false,
        onDelete: 'CASCADE',
    )]
    private User $author;

    #[ORM\ManyToOne(targetEntity: User::class, inversedBy: 'editedPosts')]
    #[ORM\JoinColumn(
        name: 'editor_id',
        referencedColumnName: 'id',
        nullable: true,
        onDelete: 'SET NULL',
    )]
    private ?User $editor = null;

    #[ORM\ManyToOne(targetEntity: Category::class, inversedBy: 'post_set')]
    #[ORM\JoinColumn(
        name: 'category_id',
        referencedColumnName: 'id',
        nullable: false,
        onDelete: 'RESTRICT',
    )]
    private Category $category;

    /** @var Collection<int, Tag> */
    #[ORM\ManyToMany(targetEntity: Tag::class, inversedBy: 'posts')]
    #[ORM\JoinTable(name: 'blog_post_tags')]
    #[ORM\JoinColumn(name: 'post_id', referencedColumnName: 'id', onDelete: 'CASCADE')]
    #[ORM\InverseJoinColumn(name: 'tag_id', referencedColumnName: 'id', onDelete: 'CASCADE')]
    private Collection $tags;

    public function __construct()
    {
        $this->createdAt = new DateTimeImmutable();
        $this->publicId = self::generateUuid();
        $this->publishedAt = new DateTimeImmutable();
        $this->tags = new ArrayCollection();
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

    public function getId(): ?int
    {
        return $this->id;
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

    public function getAuthor(): User
    {
        return $this->author;
    }

    public function setAuthor(User $author): static
    {
        $this->author = $author;

        return $this;
    }

    public function getEditor(): ?User
    {
        return $this->editor;
    }

    public function setEditor(?User $editor): static
    {
        $this->editor = $editor;

        return $this;
    }

    public function getCategory(): Category
    {
        return $this->category;
    }

    public function setCategory(Category $category): static
    {
        $this->category = $category;

        return $this;
    }

    /**
     * @return Collection<int, Tag>
     */
    public function getTags(): Collection
    {
        return $this->tags;
    }

    public function addTag(Tag $tag): static
    {
        if (!$this->tags->contains($tag)) {
            $this->tags->add($tag);
            $tag->addPost($this);
        }

        return $this;
    }

    public function removeTag(Tag $tag): static
    {
        if ($this->tags->removeElement($tag)) {
            $tag->removePost($this);
        }

        return $this;
    }

    #[ORM\PrePersist]
    #[ORM\PreUpdate]
    public function refreshAutoUpdatedFields(): void
    {
        $this->updatedAt = new DateTimeImmutable();
    }

    private static function generateUuid(): string
    {
        $bytes = random_bytes(16);
        $bytes[6] = chr((ord($bytes[6]) & 0x0f) | 0x40);
        $bytes[8] = chr((ord($bytes[8]) & 0x3f) | 0x80);

        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($bytes), 4));
    }
}
